import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { openDb, type Db } from '../../src/server/db/db.js';
import { buildApp } from '../../src/server/app.js';
import { addFolder, updateFolder } from '../../src/server/folders/folderRepo.js';
import { parseManifest, applyManifest, discoverManifests } from '../../src/server/manifest/manifest.js';
import { enqueueEligible } from '../../src/server/queue/enqueue.js';
import { scanFolder } from '../../src/server/scan/scanner.js';
import { generateMetadata } from '../../src/server/ai/generate.js';
import { extractFrames } from '../../src/server/media/frames.js';
import { setSettings } from '../../src/server/settings.js';
import { FakeProvider, validOutput } from '../fixtures/fakeProvider.js';
import { fixture, tempDir } from '../fixtures/make-fixtures.js';

const H = { 'x-localtube-token': 't' };
let db: Db;
beforeEach(() => {
  db = openDb(':memory:');
});

const clip = (file: string, over: Record<string, unknown> = {}) => ({
  file,
  cover: file.replace('.mp4', '_cover.jpg'),
  kind: 'live',
  hook_text: 'ignored',
  post_title: `Title for ${file}`,
  description: `Description for ${file}`,
  hashtags: ['#openworld', '#shorts'],
  score: 70,
  ...over,
});
const manifest = (...clips: unknown[]) => ({ stream: { name: 'Stream' }, clips });

function folderWith(files: string[], o: { autoPublish?: number } = {}) {
  const dir = tempDir('lt-mf-');
  const folder = addFolder(db, { path: dir });
  updateFolder(db, folder.id, { auto_publish: o.autoPublish ?? 1 });
  const ids: Record<string, number> = {};
  for (const f of files) {
    ids[f] = Number(db.prepare("INSERT INTO videos(folder_id,file_path,filename,discovery_status) VALUES(?,?,?,'VALID')").run(folder.id, path.join(dir, f), f).lastInsertRowid);
  }
  return { dir, folder, ids };
}
const cur = (id: number) => db.prepare('SELECT * FROM video_metadata WHERE video_id=? AND is_current=1').get(id) as Record<string, any> | undefined;
const vrow = (id: number) => db.prepare('SELECT * FROM videos WHERE id=?').get(id) as Record<string, any>;

describe('parseManifest', () => {
  it('accepts the clipper format and returns the usable fields', () => {
    const clips = parseManifest(manifest(clip('a.mp4')));
    expect(clips).toHaveLength(1);
    expect(clips[0]).toMatchObject({ file: 'a.mp4', title: 'Title for a.mp4', description: 'Description for a.mp4', hashtags: ['#openworld', '#shorts'] });
  });

  it('also accepts title instead of post_title, and a bare array of clips', () => {
    expect(parseManifest([{ file: 'a.mp4', title: 'T', description: 'D', hashtags: [] }])[0].title).toBe('T');
  });

  it('rejects things that are not a manifest', () => {
    expect(() => parseManifest(null)).toThrow();
    expect(() => parseManifest({ nothing: 1 })).toThrow(/clips/i);
    expect(() => parseManifest({ clips: 'nope' })).toThrow();
    expect(() => parseManifest({ name: 'package.json', version: '1.0.0' })).toThrow();
  });

  it('skips entries with no file or no title instead of failing the whole file', () => {
    const clips = parseManifest(manifest(clip('a.mp4'), { post_title: 'no file' }, { file: 'b.mp4' }));
    expect(clips.map((c) => c.file)).toEqual(['a.mp4']);
  });
});

describe('applyManifest', () => {
  it('writes READY metadata by file name (case-insensitive) and auto-approves in an auto-publish folder', () => {
    const { folder, ids } = folderWith(['One.MP4', 'two.mp4']);
    const r = applyManifest(db, folder.id, parseManifest(manifest(clip('one.mp4'), clip('two.mp4'))));
    expect(r).toMatchObject({ applied: 2, unmatched: [], errors: [] });
    const m = cur(ids['One.MP4'])!;
    expect(m).toMatchObject({ title: 'Title for one.mp4', description: 'Description for one.mp4', provider: 'manifest', confidence: 'high', needs_review: 0 });
    expect(JSON.parse(m.hashtags_json)).toEqual(['#openworld', '#shorts']);
    expect(vrow(ids['One.MP4'])).toMatchObject({ metadata_status: 'READY', approval_status: 'NOT_REQUIRED' });
  });

  it('a manual-review folder leaves imported videos PENDING', () => {
    const { folder, ids } = folderWith(['a.mp4'], { autoPublish: 0 });
    applyManifest(db, folder.id, parseManifest(manifest(clip('a.mp4'))));
    expect(vrow(ids['a.mp4']).approval_status).toBe('PENDING');
  });

  it('reports entries with no matching video, and videos with no entry are untouched', () => {
    const { folder, ids } = folderWith(['a.mp4', 'extra.mp4']);
    const r = applyManifest(db, folder.id, parseManifest(manifest(clip('a.mp4'), clip('ghost.mp4'))));
    expect(r.applied).toBe(1);
    expect(r.unmatched).toEqual(['ghost.mp4']);
    expect(cur(ids['extra.mp4'])).toBeUndefined();
    expect(vrow(ids['extra.mp4']).metadata_status).toBe('NOT_STARTED');
  });

  it('applies the valid entries and reports invalid ones (title too long, angle brackets) without stopping', () => {
    const { folder, ids } = folderWith(['ok.mp4', 'long.mp4', 'angle.mp4']);
    const r = applyManifest(db, folder.id, parseManifest(manifest(clip('ok.mp4'), clip('long.mp4', { post_title: 'x'.repeat(120) }), clip('angle.mp4', { post_title: 'a <b> c' }))));
    expect(r.applied).toBe(1);
    expect(r.errors.map((e) => e.file).sort()).toEqual(['angle.mp4', 'long.mp4']);
    expect(cur(ids['long.mp4'])).toBeUndefined();
    expect(cur(ids['ok.mp4'])).toBeTruthy();
  });

  it('replaces AI metadata but never overwrites a title the user edited by hand', () => {
    const { folder, ids } = folderWith(['ai.mp4', 'mine.mp4']);
    for (const [f, provider] of [['ai.mp4', 'gemini'], ['mine.mp4', 'user-edit']] as const) {
      db.prepare("INSERT INTO video_metadata(video_id,provider,title,description,hashtags_json,is_current) VALUES(?,?, 'Old title','Old','[]',1)").run(ids[f], provider);
      db.prepare("UPDATE videos SET metadata_status='READY' WHERE id=?").run(ids[f]);
    }
    const r = applyManifest(db, folder.id, parseManifest(manifest(clip('ai.mp4'), clip('mine.mp4'))));
    expect(cur(ids['ai.mp4'])!.title).toBe('Title for ai.mp4');
    expect(cur(ids['mine.mp4'])!.title).toBe('Old title');
    expect(r.skipped).toBe(1);
  });

  it('is idempotent, and an updated entry replaces the previous import', () => {
    const { folder, ids } = folderWith(['a.mp4']);
    const clips = parseManifest(manifest(clip('a.mp4')));
    expect(applyManifest(db, folder.id, clips).applied).toBe(1);
    const again = applyManifest(db, folder.id, clips);
    expect(again).toMatchObject({ applied: 0, unchanged: 1 });
    expect(db.prepare('SELECT COUNT(*) c FROM video_metadata WHERE video_id=?').get(ids['a.mp4'])).toEqual({ c: 1 });
    applyManifest(db, folder.id, parseManifest(manifest(clip('a.mp4', { post_title: 'New title' }))));
    expect(cur(ids['a.mp4'])!.title).toBe('New title');
    expect(db.prepare('SELECT COUNT(*) c FROM video_metadata WHERE video_id=?').get(ids['a.mp4'])).toEqual({ c: 2 });
  });

  it('leaves videos that are uploading or already uploaded alone', () => {
    const { folder, ids } = folderWith(['up.mp4', 'done.mp4']);
    db.prepare("UPDATE videos SET upload_status='UPLOADING' WHERE id=?").run(ids['up.mp4']);
    db.prepare("UPDATE videos SET upload_status='UPLOAD_COMPLETE' WHERE id=?").run(ids['done.mp4']);
    const r = applyManifest(db, folder.id, parseManifest(manifest(clip('up.mp4'), clip('done.mp4'))));
    expect(r.applied).toBe(0);
    expect(r.skipped).toBe(2);
  });

  it('keeps a rejected video rejected', () => {
    const { folder, ids } = folderWith(['a.mp4']);
    db.prepare("UPDATE videos SET approval_status='REJECTED' WHERE id=?").run(ids['a.mp4']);
    applyManifest(db, folder.id, parseManifest(manifest(clip('a.mp4'))));
    expect(vrow(ids['a.mp4']).approval_status).toBe('REJECTED');
  });

  it('only touches videos below the manifest directory when one is given', () => {
    const { dir, folder } = folderWith([]);
    fs.mkdirSync(path.join(dir, 'A'));
    fs.mkdirSync(path.join(dir, 'B'));
    const mk = (sub: string) => Number(db.prepare("INSERT INTO videos(folder_id,file_path,filename,discovery_status) VALUES(?,?, 'same.mp4','VALID')").run(folder.id, path.join(dir, sub, 'same.mp4')).lastInsertRowid);
    const a = mk('A');
    const b = mk('B');
    applyManifest(db, folder.id, parseManifest(manifest(clip('same.mp4'))), { dir: path.join(dir, 'A') });
    expect(cur(a)).toBeTruthy();
    expect(cur(b)).toBeUndefined();
  });

  it('feeds the normal pipeline: an imported video is queued with the manifest title', async () => {
    const dir = tempDir('lt-mf-real-');
    const file = path.join(dir, 'real.mp4');
    fs.writeFileSync(file, crypto.randomBytes(5000));
    const st = fs.statSync(file);
    const folder = addFolder(db, { path: dir });
    const id = Number(db.prepare("INSERT INTO videos(folder_id,file_path,filename,file_size_bytes,modified_at,discovery_status) VALUES(?,?,?,?,?,'VALID')").run(folder.id, file, 'real.mp4', st.size, Math.trunc(st.mtimeMs)).lastInsertRowid);
    db.prepare("INSERT INTO youtube_accounts(channel_id,channel_title,confirmed,is_enabled,secret_ref) VALUES('UC1','C',1,1,'r')").run();
    applyManifest(db, folder.id, parseManifest(manifest(clip('real.mp4'))));
    expect(await enqueueEligible(db)).toBe(1);
    const job = db.prepare('SELECT metadata_id FROM upload_jobs WHERE video_id=?').get(id) as { metadata_id: number };
    expect((db.prepare('SELECT title FROM video_metadata WHERE id=?').get(job.metadata_id) as any).title).toBe('Title for real.mp4');
  });
});

describe('discoverManifests', () => {
  it('imports every manifest-shaped JSON file in the folder and ignores unrelated or broken JSON', async () => {
    const { dir, folder, ids } = folderWith(['a.mp4', 'b.mp4']);
    fs.writeFileSync(path.join(dir, 'clips.json'), JSON.stringify(manifest(clip('a.mp4'))));
    fs.writeFileSync(path.join(dir, 'other.json'), JSON.stringify(manifest(clip('b.mp4'))));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1' }));
    fs.writeFileSync(path.join(dir, 'broken.json'), '{ not json');
    const r = await discoverManifests(db, folder.id);
    expect(r.applied).toBe(2);
    expect(r.files.sort()).toEqual(['clips.json', 'other.json']);
    expect(cur(ids['a.mp4'])).toBeTruthy();
    expect(cur(ids['b.mp4'])).toBeTruthy();
  });

  it('finds manifests in subfolders when the folder is recursive, and scopes them to that subfolder', async () => {
    const { dir, folder } = folderWith([]);
    fs.mkdirSync(path.join(dir, 'sub'));
    const sub = Number(db.prepare("INSERT INTO videos(folder_id,file_path,filename,discovery_status) VALUES(?,?, 'x.mp4','VALID')").run(folder.id, path.join(dir, 'sub', 'x.mp4')).lastInsertRowid);
    const top = Number(db.prepare("INSERT INTO videos(folder_id,file_path,filename,discovery_status) VALUES(?,?, 'x.mp4','VALID')").run(folder.id, path.join(dir, 'x.mp4')).lastInsertRowid);
    fs.writeFileSync(path.join(dir, 'sub', 'clips.json'), JSON.stringify(manifest(clip('x.mp4'))));
    await discoverManifests(db, folder.id);
    expect(cur(sub)).toBeTruthy();
    expect(cur(top)).toBeUndefined();
  });

  it('returns zero counts for a folder with no manifest, and never throws for a missing folder', async () => {
    const { folder } = folderWith(['a.mp4']);
    expect(await discoverManifests(db, folder.id)).toMatchObject({ applied: 0, files: [] });
    fs.rmSync(path.dirname(String((db.prepare('SELECT path FROM folders WHERE id=?').get(folder.id) as any).path) + '\\x'), { recursive: true, force: true });
    await expect(discoverManifests(db, folder.id)).resolves.toMatchObject({ applied: 0 });
  });

  it('never modifies the manifest file or the videos', async () => {
    const { dir, folder } = folderWith(['a.mp4']);
    const f = path.join(dir, 'clips.json');
    fs.writeFileSync(f, JSON.stringify(manifest(clip('a.mp4'))));
    const before = [fs.statSync(f).mtimeMs, fs.readFileSync(f, 'utf8')];
    await discoverManifests(db, folder.id);
    expect([fs.statSync(f).mtimeMs, fs.readFileSync(f, 'utf8')]).toEqual(before);
  });
});

describe('manifest routes', () => {
  it('POST /api/folders/:id/import-metadata applies a manifest sent by the browser', async () => {
    const { folder, ids } = folderWith(['a.mp4']);
    const app = buildApp({ db, token: 't' });
    const r = await app.inject({ method: 'POST', url: `/api/folders/${folder.id}/import-metadata`, headers: H, payload: manifest(clip('a.mp4'), clip('missing.mp4')) });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ applied: 1, unmatched: ['missing.mp4'] });
    expect(cur(ids['a.mp4'])!.title).toBe('Title for a.mp4');
  });

  it('rejects a body that is not a manifest, and an unknown folder', async () => {
    const { folder } = folderWith(['a.mp4']);
    const app = buildApp({ db, token: 't' });
    expect((await app.inject({ method: 'POST', url: `/api/folders/${folder.id}/import-metadata`, headers: H, payload: { hello: 1 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/folders/999/import-metadata', headers: H, payload: manifest(clip('a.mp4')) })).statusCode).toBe(404);
  });

  it('accepts a large manifest (hundreds of clips)', async () => {
    const files = Array.from({ length: 300 }, (_, i) => `c${i}.mp4`);
    const { folder } = folderWith(files);
    const app = buildApp({ db, token: 't' });
    const r = await app.inject({ method: 'POST', url: `/api/folders/${folder.id}/import-metadata`, headers: H, payload: manifest(...files.map((f) => clip(f, { padding: 'x'.repeat(2000) }))) });
    expect(r.statusCode).toBe(200);
    expect(r.json().applied).toBe(300);
  });

  it('the scan route also imports a clips.json found in the folder', async () => {
    const dir = tempDir('lt-mf-scan-');
    fs.copyFileSync(fixture('short'), path.join(dir, 'a.mp4'));
    fs.writeFileSync(path.join(dir, 'clips.json'), JSON.stringify(manifest(clip('a.mp4', { post_title: 'From the JSON' }))));
    const folder = addFolder(db, { path: dir });
    const app = buildApp({ db, token: 't' });
    const r = await app.inject({ method: 'POST', url: `/api/folders/${folder.id}/scan`, headers: H });
    expect(r.json().metadata).toMatchObject({ applied: 1 });
    const id = (db.prepare('SELECT id FROM videos').get() as { id: number }).id;
    expect(cur(id)!.title).toBe('From the JSON');
  });
});

describe('manifest and AI together', () => {
  it('AI generation that finishes after a manifest import does not overwrite it', async () => {
    const dir = tempDir('lt-mf-ai-');
    fs.copyFileSync(fixture('short'), path.join(dir, 'a.mp4'));
    const folder = addFolder(db, { path: dir });
    await scanFolder(db, folder.id, { stableMs: 30 });
    setSettings(db, { aiConsent: true });
    const id = (db.prepare('SELECT id FROM videos').get() as { id: number }).id;
    // The JSON is imported exactly while the AI call is in flight (deterministic, no timing).
    const provider = new FakeProvider({
      respond: (n) => {
        applyManifest(db, folder.id, parseManifest(manifest(clip('a.mp4', { post_title: 'From the JSON' }))));
        return validOutput(n);
      },
    });
    await generateMetadata({ db, provider, tempDir: tempDir('lt-w-'), retryDelayMs: 0, frameCount: 2 }, id);
    expect(cur(id)!.title).toBe('From the JSON');
    expect(cur(id)!.provider).toBe('manifest');
    expect(vrow(id).metadata_status).toBe('READY');
  });

  it('a JSON imported while frames are still being extracted leaves the video READY, not stuck in GENERATING', async () => {
    const dir = tempDir('lt-mf-ai3-');
    fs.copyFileSync(fixture('short'), path.join(dir, 'a.mp4'));
    const folder = addFolder(db, { path: dir });
    await scanFolder(db, folder.id, { stableMs: 30 });
    setSettings(db, { aiConsent: true });
    const id = (db.prepare('SELECT id FROM videos').get() as { id: number }).id;
    const provider = new FakeProvider();
    await generateMetadata(
      {
        db, provider, tempDir: tempDir('lt-w-'), retryDelayMs: 0, frameCount: 2,
        extract: async (...args) => {
          const out = await extractFrames(...args);
          applyManifest(db, folder.id, parseManifest(manifest(clip('a.mp4', { post_title: 'From the JSON' })))); // lands before the AI call starts
          return out;
        },
      },
      id,
    );
    expect(vrow(id).metadata_status).toBe('READY');
    expect(cur(id)!.title).toBe('From the JSON');
    expect(provider.calls).toBe(0); // no point asking the AI once the JSON has supplied the text
  });

  it('the AI worker does not regenerate a video that already has manifest metadata', async () => {
    const dir = tempDir('lt-mf-ai2-');
    fs.copyFileSync(fixture('short'), path.join(dir, 'a.mp4'));
    const folder = addFolder(db, { path: dir });
    await scanFolder(db, folder.id, { stableMs: 30 });
    setSettings(db, { aiConsent: true });
    const id = (db.prepare('SELECT id FROM videos').get() as { id: number }).id;
    applyManifest(db, folder.id, parseManifest(manifest(clip('a.mp4', { post_title: 'From the JSON' }))));
    const provider = new FakeProvider();
    await generateMetadata({ db, provider, tempDir: tempDir('lt-w-'), retryDelayMs: 0, frameCount: 2 }, id);
    expect(provider.calls).toBe(0);
    expect(cur(id)!.title).toBe('From the JSON');
  });
});
