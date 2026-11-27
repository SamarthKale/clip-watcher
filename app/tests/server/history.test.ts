import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { openDb, type Db } from '../../src/server/db/db.js';
import { buildApp } from '../../src/server/app.js';
import { addFolder, removeFolder } from '../../src/server/folders/folderRepo.js';
import { searchHistory, exportCsv } from '../../src/server/history/history.js';
import { startRuntime } from '../../src/server/runtime.js';
import { startScanLoop } from '../../src/server/scan/scanLoop.js';
import { setSettings } from '../../src/server/settings.js';
import { startFakeYouTube, type FakeYouTube } from '../fixtures/fakeYouTube.js';
import { FakeProvider } from '../fixtures/fakeProvider.js';
import { fixture, tempDir } from '../fixtures/make-fixtures.js';

const H = { 'x-localtube-token': 't' };
let db: Db;
beforeEach(() => {
  db = openDb(':memory:');
});

/** Minimal RFC 4180 parser for the round-trip checks. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\r' && text[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

let n = 0;
interface V { video?: number; job?: number }
function addUpload(o: { title?: string; status?: string; ytId?: string | null; folderPath?: string; processing?: string; privacy?: string | null; visibility?: string; err?: string; attempts?: number; description?: string } = {}): V {
  n++;
  const folder = addFolder(db, { path: o.folderPath ?? `D:\\Folder${n}` });
  const video = Number(
    db.prepare("INSERT INTO videos(folder_id,file_path,filename,content_hash,file_size_bytes,duration_seconds,upload_status,processing_status,youtube_privacy) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(folder.id, `${folder.path}\\clip${n}.mp4`, `clip${n}.mp4`, `hash${n}`, 1000 + n, 12.5, o.status ?? 'UPLOAD_COMPLETE', o.processing ?? 'NOT_CHECKED', o.privacy ?? null).lastInsertRowid,
  );
  const meta = Number(
    db.prepare("INSERT INTO video_metadata(video_id,ai_profile_id,prompt_version,title,description,hashtags_json,is_current) VALUES(?,1,3,?,?,?,1)").run(video, o.title ?? `Title ${n}`, o.description ?? 'Desc', '["#Shorts"]').lastInsertRowid,
  );
  const acct = (db.prepare('SELECT id FROM youtube_accounts LIMIT 1').get() as { id: number } | undefined)?.id
    ?? Number(db.prepare("INSERT INTO youtube_accounts(channel_id,channel_title,confirmed,is_enabled) VALUES('UCabc','My Chan',1,1)").run().lastInsertRowid);
  const job = Number(
    db.prepare("INSERT INTO upload_jobs(video_id,youtube_account_id,metadata_id,visibility,status,youtube_video_id,last_error_code,last_error_message,attempt_count,upload_started_at,upload_completed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(video, acct, meta, o.visibility ?? 'public', o.status ?? 'UPLOAD_COMPLETE', o.ytId === undefined ? `yt${String(n).padStart(9, '0')}` : o.ytId, o.err ? 'permanent' : null, o.err ?? null, o.attempts ?? 1, '2026-11-19T10:00:00Z', '2026-11-19T10:05:00Z').lastInsertRowid,
  );
  return { video, job };
}

describe('history and CSV', () => {
  it('a title with a comma, quote and newline round-trips through CSV', () => {
    addUpload({ title: 'He said "wow", then\nleft', description: 'line1\r\nline2, "q"' });
    const rows = parseCsv(exportCsv(searchHistory(db, { pageSize: 1000 })));
    const head = rows[0];
    const r = rows[1];
    expect(r[head.indexOf('title')]).toBe('He said "wow", then\nleft');
    expect(r[head.indexOf('description')]).toBe('line1\r\nline2, "q"');
    expect(rows).toHaveLength(2);
  });

  it('includes the YouTube id and URL, the fingerprint, profile version, channel and retry count', () => {
    addUpload({ ytId: 'abcdefghijk', attempts: 3 });
    const rows = parseCsv(exportCsv(searchHistory(db, {})));
    const h = rows[0];
    const r = rows[1];
    expect(r[h.indexOf('youtube_video_id')]).toBe('abcdefghijk');
    expect(r[h.indexOf('youtube_url')]).toBe('https://youtu.be/abcdefghijk');
    expect(r[h.indexOf('fingerprint')]).toMatch(/^hash/);
    expect(r[h.indexOf('prompt_version')]).toBe('3');
    expect(r[h.indexOf('channel_id')]).toBe('UCabc');
    expect(r[h.indexOf('retry_count')]).toBe('3');
    for (const col of ['folder', 'file_path', 'filename', 'file_size_bytes', 'duration_seconds', 'visibility', 'upload_started_at', 'upload_completed_at', 'result', 'processing_status', 'error_category', 'last_error', 'ai_profile']) {
      expect(h, col).toContain(col);
    }
  });

  it('neutralises spreadsheet formulas in untrusted text', () => {
    addUpload({ title: '=HYPERLINK("http://evil","x")', description: '+cmd|calc' });
    const rows = parseCsv(exportCsv(searchHistory(db, {})));
    const h = rows[0];
    expect(rows[1][h.indexOf('title')].startsWith("'=")).toBe(true);
    expect(rows[1][h.indexOf('description')].startsWith("'+")).toBe(true);
  });

  it('history survives removing its folder', () => {
    addUpload({ folderPath: 'D:\\Gone' });
    removeFolder(db, 1);
    expect(searchHistory(db, {})).toHaveLength(1);
  });

  it('searches by text, folder and status, and paginates', () => {
    for (let i = 0; i < 5; i++) addUpload({ title: `Clutch ${i}` });
    addUpload({ title: 'Fail', status: 'FAILED_PERMANENTLY', ytId: null, err: 'bad metadata' });
    expect(searchHistory(db, { text: 'clutch' })).toHaveLength(5);
    expect(searchHistory(db, { text: '100%' })).toHaveLength(0); // % is literal, not a wildcard
    expect(searchHistory(db, { status: 'FAILED_PERMANENTLY' })).toHaveLength(1);
    expect(searchHistory(db, { folderId: 1 })).toHaveLength(1);
    expect(searchHistory(db, { pageSize: 4, page: 1 })).toHaveLength(4);
    expect(searchHistory(db, { pageSize: 4, page: 2 })).toHaveLength(2);
    const failed = searchHistory(db, { status: 'FAILED_PERMANENTLY' })[0];
    expect(failed.last_error).toBe('bad metadata');
    expect(failed.youtube_url).toBe('');
  });

  it('flags published only when YouTube finished processing and privacy matches', () => {
    addUpload({ processing: 'READY', privacy: 'public', visibility: 'public' });
    addUpload({ processing: 'READY', privacy: 'private', visibility: 'public' });
    addUpload({ processing: 'PROCESSING', privacy: 'public', visibility: 'public' });
    expect(searchHistory(db, {}).map((r) => r.published).sort()).toEqual([0, 0, 1]);
  });
});

describe('history routes', () => {
  it('GET /api/history.csv is a downloadable UTF-8 CSV with every row, not just a page', async () => {
    for (let i = 0; i < 60; i++) addUpload();
    const app = buildApp({ db, token: 't' });
    const r = await app.inject({ method: 'GET', url: '/api/history.csv', headers: H });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/csv/);
    expect(r.headers['content-disposition']).toMatch(/attachment; filename="localtube-history/);
    expect(parseCsv(r.body.replace(/^\uFEFF/, '')).length).toBe(61);
  });

  it('GET /api/history supports filters', async () => {
    addUpload({ title: 'Alpha' });
    addUpload({ title: 'Beta' });
    const app = buildApp({ db, token: 't' });
    const r = await app.inject({ method: 'GET', url: '/api/history?text=alp', headers: H });
    expect(r.json().rows).toHaveLength(1);
  });
});

describe('dashboard', () => {
  it('is all zeros with no data: no fabricated metrics', async () => {
    const app = buildApp({ db, token: 't' });
    const d = (await app.inject({ method: 'GET', url: '/api/dashboard', headers: H })).json();
    expect(d.counts).toEqual({
      detected: 0, enhancing: 0, metadataReady: 0, awaitingApproval: 0, queued: 0, uploading: 0, uploadComplete: 0, published: 0, failed: 0, skipped: 0,
    });
    expect(d.recent).toEqual([]);
    expect(d.channel).toBeNull();
    expect(d.paused).toBe(false);
  });

  it('reports jobs blocked by YouTube limits so the UI can explain why nothing uploads', async () => {
    addUpload({ status: 'BLOCKED_BY_CHANNEL_LIMIT', ytId: null });
    addUpload({ status: 'BLOCKED_BY_CHANNEL_LIMIT', ytId: null });
    addUpload({ status: 'BLOCKED_BY_QUOTA', ytId: null });
    db.prepare("UPDATE upload_jobs SET last_error_message='The user has exceeded the number of videos they may upload.' WHERE status='BLOCKED_BY_CHANNEL_LIMIT'").run();
    db.prepare("UPDATE upload_jobs SET next_retry_at='2026-11-20T08:05:00.000Z' WHERE status='BLOCKED_BY_QUOTA'").run();
    const app = buildApp({ db, token: 't' });
    const d = (await app.inject({ method: 'GET', url: '/api/dashboard', headers: H })).json();
    expect(d.blocked).toMatchObject({ channelLimit: 2, quota: 1, resumeAfter: '2026-11-20T08:05:00.000Z' });
    expect(d.blocked.message).toMatch(/exceeded/);
  });

  it('blocked is all zeros when nothing is blocked', async () => {
    const app = buildApp({ db, token: 't' });
    const d = (await app.inject({ method: 'GET', url: '/api/dashboard', headers: H })).json();
    expect(d.blocked).toEqual({ channelLimit: 0, quota: 0, resumeAfter: null, message: null });
  });

  it('counts each state and shows the confirmed channel and recent activity', async () => {
    addUpload({ status: 'UPLOAD_COMPLETE', processing: 'READY', privacy: 'public' });
    addUpload({ status: 'UPLOAD_COMPLETE', processing: 'PROCESSING' });
    addUpload({ status: 'UPLOADING', ytId: null });
    addUpload({ status: 'QUEUED', ytId: null });
    addUpload({ status: 'BLOCKED_BY_QUOTA', ytId: null });
    addUpload({ status: 'FAILED_PERMANENTLY', ytId: null });
    addUpload({ status: 'UPLOAD_OUTCOME_UNKNOWN', ytId: null });
    addUpload({ status: 'CANCELLED', ytId: null });
    for (const k of [1, 2]) {
      db.prepare("INSERT INTO videos(folder_id,file_path,filename,approval_status) VALUES(1,?,?, 'PENDING')").run(`D:\\Folder1\\extra${k}.mp4`, `extra${k}.mp4`);
    }
    db.prepare("UPDATE videos SET metadata_status='READY'").run();
    db.prepare("UPDATE videos SET approval_status='NOT_REQUIRED' WHERE id <= 8").run();
    db.prepare("INSERT INTO activity_log(entity_type,entity_id,event_type,message) VALUES('job',1,'upload_complete','Uploaded')").run();
    const app = buildApp({ db, token: 't' });
    const d = (await app.inject({ method: 'GET', url: '/api/dashboard', headers: H })).json();
    expect(d.counts).toMatchObject({ detected: 10, metadataReady: 10, awaitingApproval: 2, uploading: 1, uploadComplete: 1, published: 1, queued: 2, failed: 2, skipped: 1 });
    expect(d.channel).toMatchObject({ channel_id: 'UCabc', channel_title: 'My Chan' });
    expect(d.recent[0].message).toBe('Uploaded');
  });
});

describe('library, scan and republish routes', () => {
  it('scan route discovers files and the library lists them with metadata and filters', async () => {
    const dir = tempDir('lt-lib-');
    fs.copyFileSync(fixture('short'), path.join(dir, 'a.mp4'));
    const folder = addFolder(db, { path: dir });
    setSettings(db, { stableMs: 100 });
    const app = buildApp({ db, token: 't' });
    const scan = await app.inject({ method: 'POST', url: `/api/folders/${folder.id}/scan`, headers: H });
    expect(scan.json()).toMatchObject({ found: 1, added: 1 });
    expect((await app.inject({ method: 'POST', url: '/api/folders/999/scan', headers: H })).statusCode).toBe(404);

    const lib = (await app.inject({ method: 'GET', url: '/api/videos', headers: H })).json();
    expect(lib.videos).toHaveLength(1);
    expect(lib.videos[0]).toMatchObject({ filename: 'a.mp4', discovery_status: 'VALID', metadata_status: 'NOT_STARTED', title: null });
    expect((await app.inject({ method: 'GET', url: '/api/videos?metadataStatus=READY', headers: H })).json().videos).toHaveLength(0);
    expect((await app.inject({ method: 'GET', url: `/api/videos?folderId=${folder.id}`, headers: H })).json().videos).toHaveLength(1);
  });

  it('errorsOnly returns videos with a failed metadata, upload or file state', async () => {
    addUpload({ status: 'UPLOAD_COMPLETE' });
    addUpload({ status: 'FAILED_PERMANENTLY', ytId: null, err: 'bad metadata' });
    const app = buildApp({ db, token: 't' });
    const r = (await app.inject({ method: 'GET', url: '/api/videos?errorsOnly=1', headers: H })).json();
    expect(r.videos).toHaveLength(1);
    expect(r.videos[0].last_error).toBe('bad metadata');
  });

  it('serves a JPEG thumbnail and 404s for an unknown video', async () => {
    const dir = tempDir('lt-thumb-');
    fs.copyFileSync(fixture('short'), path.join(dir, 'a.mp4'));
    const folder = addFolder(db, { path: dir });
    const app = buildApp({ db, token: 't' });
    await app.inject({ method: 'POST', url: `/api/folders/${folder.id}/scan`, headers: H });
    const id = (db.prepare('SELECT id FROM videos').get() as { id: number }).id;
    const r = await app.inject({ method: 'GET', url: `/api/videos/${id}/thumbnail`, headers: H });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('image/jpeg');
    expect(r.rawPayload.subarray(0, 2).toString('hex')).toBe('ffd8');
    expect((await app.inject({ method: 'GET', url: '/api/videos/9999/thumbnail', headers: H })).statusCode).toBe(404);
  });

  it('allow-republish clears a DUPLICATE flag', async () => {
    const { video } = addUpload({ status: 'NOT_QUEUED', ytId: null });
    db.prepare("UPDATE videos SET discovery_status='DUPLICATE' WHERE id=?").run(video);
    const app = buildApp({ db, token: 't' });
    expect((await app.inject({ method: 'POST', url: `/api/videos/${video}/allow-republish`, headers: H })).statusCode).toBe(200);
    expect((db.prepare('SELECT discovery_status s FROM videos WHERE id=?').get(video) as any).s).toBe('VALID');
  });
});

describe('scan loop', () => {
  it('scans every enabled folder at start and stops cleanly', async () => {
    const a = tempDir('lt-sl-a-');
    const b = tempDir('lt-sl-b-');
    fs.copyFileSync(fixture('short'), path.join(a, 'a.mp4'));
    fs.copyFileSync(fixture('other'), path.join(b, 'b.mp4'));
    addFolder(db, { path: a });
    addFolder(db, { path: b });
    const gone = addFolder(db, { path: tempDir('lt-sl-c-') });
    removeFolder(db, gone.id);
    const loop = startScanLoop(db, { intervalMs: () => 0, stableMs: () => 30 });
    await loop.runNow();
    loop.stop();
    expect((db.prepare('SELECT COUNT(*) c FROM videos').get() as any).c).toBe(2);
  });
});

describe('runtime', () => {
  let yt: FakeYouTube;
  afterEach(async () => {
    await yt?.close();
  });

  it('recovers an interrupted job, uploads it, and shuts down cleanly', async () => {
    yt = await startFakeYouTube();
    const dir = tempDir('lt-rt-');
    const file = path.join(dir, 'a.mp4');
    fs.copyFileSync(fixture('short'), file);
    const folder = addFolder(db, { path: dir });
    const st = fs.statSync(file);
    db.prepare("INSERT INTO youtube_accounts(channel_id,channel_title,confirmed,is_enabled,secret_ref) VALUES('UC1','C',1,1,'r')").run();
    const v = Number(db.prepare("INSERT INTO videos(folder_id,file_path,filename,file_size_bytes,modified_at,discovery_status,metadata_status,approval_status,upload_status) VALUES(?,?,?,?,?,'VALID','READY','NOT_REQUIRED','UPLOADING')").run(folder.id, file, 'a.mp4', st.size, Math.trunc(st.mtimeMs)).lastInsertRowid);
    const m = Number(db.prepare("INSERT INTO video_metadata(video_id,title,description,is_current) VALUES(?,'T','D',1)").run(v).lastInsertRowid);
    db.prepare("INSERT INTO upload_jobs(video_id,youtube_account_id,metadata_id,status,attempt_count,file_fingerprint) VALUES(?,1,?,'UPLOADING',1,?)").run(v, m, `${st.size}:${Math.trunc(st.mtimeMs)}:abc`);

    const rt = await startRuntime({
      db,
      auth: { getAccessToken: async () => 'AT' },
      getProvider: async () => new FakeProvider(),
      tempDir: () => tempDir('lt-rt-tmp-'),
      uploadBaseUrl: yt.baseUrl,
      pollMs: 10,
      statusIntervalMs: 50,
      scanIntervalMs: 0,
      fetchVideos: async (ids) => ids.map((id) => ({ id, uploadStatus: 'processed', privacyStatus: 'public', processingStatus: 'succeeded' })),
    });
    const t0 = Date.now();
    const status = () => (db.prepare('SELECT status FROM upload_jobs').get() as { status: string }).status;
    while (status() !== 'UPLOAD_COMPLETE' && Date.now() - t0 < 10000) await new Promise((r) => setTimeout(r, 20));
    expect(status()).toBe('UPLOAD_COMPLETE');
    expect(yt.videos).toHaveLength(1);
    while ((db.prepare('SELECT processing_status s FROM videos').get() as any).s !== 'READY' && Date.now() - t0 < 10000) await new Promise((r) => setTimeout(r, 20));
    expect((db.prepare('SELECT processing_status s FROM videos').get() as any).s).toBe('READY');
    await rt.stop();
    await rt.stop(); // idempotent
  });
});
