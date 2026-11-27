import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { openDb } from '../../src/server/db/db.js';
import { addFolder } from '../../src/server/folders/folderRepo.js';
import { scanFolder } from '../../src/server/scan/scanner.js';
import { sha256File } from '../../src/server/scan/fingerprint.js';
import { createSecretStore } from '../../src/server/secrets/secretStore.js';
import { setSettings } from '../../src/server/settings.js';
import { startFakeGoogle, type FakeGoogle } from '../fixtures/fakeGoogle.js';
import { startFakeYouTube, type FakeYouTube } from '../fixtures/fakeYouTube.js';
import { makeFixtureMp4, tempDir } from '../fixtures/make-fixtures.js';

const CHUNK = 256 * 1024;
const win = process.platform === 'win32';

interface FakeGemini {
  baseUrl: string;
  requests: { headers: http.IncomingHttpHeaders; body: string }[];
  close(): Promise<void>;
}
async function startFakeGemini(): Promise<FakeGemini> {
  const requests: FakeGemini['requests'] = [];
  let n = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      requests.push({ headers: req.headers, body });
      res.setHeader('content-type', 'application/json');
      const out = { title: `Unreal clutch ${++n}`, description: 'A clean clip with a wild finish.', hashtags: ['#Clutch'], confidence: 'high', needsReview: false };
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] }, finishReason: 'STOP' }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

let children: ChildProcess[] = [];
let yt: FakeYouTube | undefined;
let google: FakeGoogle | undefined;
let gemini: FakeGemini | undefined;
afterEach(async () => {
  for (const c of children) c.kill('SIGKILL');
  children = [];
  await yt?.close();
  await google?.close();
  await gemini?.close();
});

function startHarness(cfg: object, out: string[]): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--import', 'tsx', path.resolve('tests/e2e/harness.ts')], {
    env: { ...process.env, HARNESS: JSON.stringify(cfg), VITEST: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  child.stderr!.on('data', (d: Buffer) => out.push(d.toString()));
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`harness did not start: ${out.join('')}`)), 30_000);
    child.stdout!.on('data', (d: Buffer) => {
      out.push(d.toString());
      if (d.toString().includes('HARNESS_READY')) { clearTimeout(t); resolve(child); }
    });
    child.on('exit', (code) => reject(new Error(`harness exited early (${code}): ${out.join('')}`)));
  });
}

async function waitFor(cond: () => boolean, ms: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe.runIf(win)('end to end: scan -> AI -> upload, with a hard crash in the middle', () => {
  it('uploads each unique video exactly once across a SIGKILL, never touches the sources, and logs no secrets', async () => {
    yt = await startFakeYouTube();
    google = await startFakeGoogle();
    gemini = await startFakeGemini();

    // Source folder: two different videos plus a byte-identical copy of the first.
    const dir = tempDir('lt-e2e-src-');
    const a = path.join(dir, 'a.mp4');
    const b = path.join(dir, 'b.mp4');
    makeFixtureMp4(a, { seconds: 4, width: 360, height: 640, seed: 'A', noisy: true });
    makeFixtureMp4(b, { seconds: 4, width: 360, height: 640, seed: 'B', noisy: true });
    fs.copyFileSync(a, path.join(dir, 'a-copy.mp4'));
    expect(fs.statSync(a).size).toBeGreaterThan(CHUNK * 2);
    const before = Object.fromEntries(
      await Promise.all(['a.mp4', 'b.mp4', 'a-copy.mp4'].map(async (n) => [n, { hash: await sha256File(path.join(dir, n)), mtime: fs.statSync(path.join(dir, n)).mtimeMs }])),
    );

    // App data: a scanned folder, a confirmed channel and the two secrets, set up exactly as the UI would.
    const dataDir = tempDir('lt-e2e-data-');
    const dbFile = path.join(dataDir, 'localtube.db');
    const db = openDb(dbFile);
    setSettings(db, { aiConsent: true });
    const folder = addFolder(db, { path: dir });
    await scanFolder(db, folder.id, { stableMs: 50 });
    expect((db.prepare("SELECT COUNT(*) c FROM videos WHERE discovery_status='VALID'").get() as any).c).toBe(3);
    const acct = Number(db.prepare("INSERT INTO youtube_accounts(channel_id,channel_title,confirmed,is_enabled,secret_ref) VALUES('UCe2e','E2E Channel',1,1,'youtube-refresh-1')").run().lastInsertRowid);
    db.close();
    const secrets = createSecretStore(path.join(dataDir, 'secrets.json'));
    await secrets.set('youtube-refresh-1', 'RT-e2e-refresh-secret');
    await secrets.set('geminiApiKey', 'GEMKEY-e2e-123456');
    void acct;

    const cfg = { dataDir, ytBase: yt.baseUrl, geminiBase: gemini.baseUrl, tokenUrl: google.endpoints.tokenUrl, chunkBytes: CHUNK };
    const out: string[] = [];

    // Run 1: crash hard during the second chunk of the first upload.
    let first: ChildProcess | undefined;
    let killed = false;
    yt.hook = (c) => {
      if (!killed && c.start > 0) {
        killed = true;
        first!.kill('SIGKILL'); // the process dies without any chance to clean up
      }
      return undefined;
    };
    first = await startHarness(cfg, out);
    await waitFor(() => killed, 60_000, 'the crash point');
    await new Promise((r) => setTimeout(r, 300));
    expect(yt.videos).toHaveLength(0);
    expect(yt.sessionsStarted).toBe(1);

    // Between runs: the job is persisted as UPLOADING with its session reference.
    const mid = openDb(dbFile);
    const stuck = mid.prepare("SELECT status, resumable_session_reference ref FROM upload_jobs WHERE status='UPLOADING'").all() as { status: string; ref: string | null }[];
    expect(stuck).toHaveLength(1);
    expect(stuck[0].ref).toContain('/upload/session/');
    mid.close();

    // Run 2: a brand new process recovers from the database alone and finishes the batch.
    yt.hook = undefined;
    await startHarness(cfg, out);
    const check = () => {
      const d = openDb(dbFile);
      try {
        return (d.prepare("SELECT COUNT(*) c FROM upload_jobs WHERE status='UPLOAD_COMPLETE'").get() as { c: number }).c;
      } finally {
        d.close();
      }
    };
    await waitFor(() => check() === 2, 90_000, 'both unique videos to upload');
    await new Promise((r) => setTimeout(r, 500)); // a duplicate upload, if any, would show up now

    const fin = openDb(dbFile);
    expect(yt.videos).toHaveLength(2); // exactly one per unique video: no duplicate after the crash
    expect(yt.sessionsStarted).toBe(2); // the crashed upload resumed its session instead of starting another
    const hashes = new Set(yt.videos.map((v) => v.sha256));
    expect(hashes).toEqual(new Set([before['a.mp4'].hash, before['b.mp4'].hash]));
    // Of the two byte-identical files, whichever was discovered first uploads and the other is a duplicate.
    const dups = fin.prepare("SELECT id, filename FROM videos WHERE discovery_status = 'DUPLICATE'").all() as { id: number; filename: string }[];
    expect(dups).toHaveLength(1);
    expect(['a.mp4', 'a-copy.mp4']).toContain(dups[0].filename);
    expect((fin.prepare('SELECT COUNT(*) c FROM upload_jobs').get() as any).c).toBe(2);
    expect((fin.prepare('SELECT COUNT(*) c FROM upload_jobs WHERE video_id = ?').get(dups[0].id) as any).c).toBe(0);
    for (const v of yt.videos) expect(v.meta.snippet.title).toMatch(/^Unreal clutch \d+$/);
    // Processing status is tracked separately from the transfer.
    await waitFor(() => (fin.prepare("SELECT COUNT(*) c FROM videos WHERE processing_status='READY'").get() as any).c === 2, 15_000, 'YouTube processing status');
    fin.close();

    // Source files: byte for byte and timestamp for timestamp unchanged.
    for (const n of Object.keys(before)) {
      expect(await sha256File(path.join(dir, n))).toBe(before[n].hash);
      expect(fs.statSync(path.join(dir, n)).mtimeMs).toBe(before[n].mtime);
    }
    expect(fs.readdirSync(dir).sort()).toEqual(['a-copy.mp4', 'a.mp4', 'b.mp4']);

    // No secret appears in logs or process output.
    const logDir = path.join(dataDir, 'logs');
    const logs = fs.existsSync(logDir) ? fs.readdirSync(logDir).map((f) => fs.readFileSync(path.join(logDir, f), 'utf8')).join('\n') : '';
    for (const secret of ['RT-e2e-refresh-secret', 'GEMKEY-e2e-123456', 'AT-refreshed']) {
      expect(logs, `log contains ${secret}`).not.toContain(secret);
      expect(out.join(''), `output contains ${secret}`).not.toContain(secret);
    }
    // And the AI provider only ever saw frames and prompt text, never OAuth tokens.
    for (const r of gemini.requests) {
      expect(r.body).not.toContain('RT-e2e-refresh-secret');
      expect(r.body).not.toContain('AT-refreshed');
    }
    expect(gemini.requests.length).toBeGreaterThan(0);
  }, 180_000);
});
