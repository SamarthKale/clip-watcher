import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDb, type Db } from '../../src/server/db/db.js';
import { buildApp } from '../../src/server/app.js';
import { addFolder, updateFolder } from '../../src/server/folders/folderRepo.js';
import { scanFolder } from '../../src/server/scan/scanner.js';
import { sha256File } from '../../src/server/scan/fingerprint.js';
import { setSettings } from '../../src/server/settings.js';
import { extractFrames } from '../../src/server/media/frames.js';
import { generateMetadata } from '../../src/server/ai/generate.js';
import { startAiWorker, resetStuckAi } from '../../src/server/ai/aiWorker.js';
import { AiError } from '../../src/server/ai/provider.js';
import { updateProfile, listProfiles } from '../../src/server/ai/profileRepo.js';
import { FakeProvider, validOutput } from '../fixtures/fakeProvider.js';
import { fixture, makeFixtureMp4, tempDir } from '../fixtures/make-fixtures.js';

const H = { 'x-localtube-token': 't' };
let db: Db;
let work: string;
beforeEach(() => {
  db = openDb(':memory:');
  setSettings(db, { aiConsent: true });
  work = tempDir('lt-work-');
});

async function oneVideo(opts: { seed?: string } = {}): Promise<{ id: number; file: string; dir: string; folderId: number }> {
  const dir = tempDir('lt-src-');
  const file = path.join(dir, 'clip.mp4');
  if (opts.seed) makeFixtureMp4(file, { seed: opts.seed });
  else fs.copyFileSync(fixture('short'), file);
  const folder = addFolder(db, { path: dir });
  await scanFolder(db, folder.id, { stableMs: 30 });
  const row = db.prepare('SELECT id FROM videos WHERE file_path = ?').get(file) as { id: number };
  return { id: row.id, file, dir, folderId: folder.id };
}
const video = (id: number) => db.prepare('SELECT * FROM videos WHERE id = ?').get(id) as Record<string, any>;
const current = (id: number) => db.prepare('SELECT * FROM video_metadata WHERE video_id = ? AND is_current = 1').get(id) as Record<string, any> | undefined;
const deps = (provider: FakeProvider) => ({ db, provider, tempDir: work, retryDelayMs: 0, frameCount: 3 });

function dims(jpg: string): { w: number; h: number } {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', jpg]).toString().trim();
  const [w, h] = out.split(',').map(Number);
  return { w, h };
}

describe('extractFrames', () => {
  it('returns the requested number of JPEG frames within the size limit', async () => {
    const out = tempDir('lt-frames-');
    const frames = await extractFrames(fixture('short'), 1, 3, out);
    expect(frames).toHaveLength(3);
    for (const f of frames) {
      expect(fs.readFileSync(f).subarray(0, 2).toString('hex')).toBe('ffd8');
      const d = dims(f);
      expect(Math.max(d.w, d.h)).toBeLessThanOrEqual(768);
    }
  });

  it('clamps the count to 8 and downsizes large portrait video', async () => {
    const big = path.join(tempDir(), 'big.mp4');
    makeFixtureMp4(big, { width: 1080, height: 1920, seconds: 1 });
    const out = tempDir('lt-frames-');
    const frames = await extractFrames(big, 1, 20, out);
    expect(frames).toHaveLength(8);
    expect(dims(frames[0])).toEqual({ w: 432, h: 768 });
  });

  it('does not modify the source file', async () => {
    const src = fixture('short');
    const before = [fs.statSync(src).size, fs.statSync(src).mtimeMs, await sha256File(src)];
    await extractFrames(src, 1, 2, tempDir('lt-frames-'));
    expect([fs.statSync(src).size, fs.statSync(src).mtimeMs, await sha256File(src)]).toEqual(before);
  });
});

describe('generateMetadata', () => {
  it('saves current metadata with provider, model, prompt version and hash; merges fixed hashtags; auto approval', async () => {
    const { id } = await oneVideo();
    const p = new FakeProvider();
    const r = await generateMetadata(deps(p), id);
    expect(r.status).toBe('ready');
    const m = current(id)!;
    expect(m).toMatchObject({ title: 'Hook 1', description: 'Desc 1', provider: 'fake', model: 'fake-model', prompt_version: 1, confidence: 'high' });
    expect(m.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(m.hashtags_json)).toEqual(['#Shorts', '#Clutch']);
    expect(video(id)).toMatchObject({ metadata_status: 'READY', approval_status: 'NOT_REQUIRED' });
    expect(p.inputs[0].frames).toHaveLength(3);
    expect(p.inputs[0].userText).toContain('clip.mp4');
  });

  it('a manual-review folder lands PENDING even for a confident result', async () => {
    const { id, folderId } = await oneVideo();
    updateFolder(db, folderId, { auto_publish: 0 });
    await generateMetadata(deps(new FakeProvider()), id);
    expect(video(id).approval_status).toBe('PENDING');
  });

  it('a low-confidence result lands PENDING and is not auto-approved', async () => {
    const { id } = await oneVideo();
    await generateMetadata(deps(new FakeProvider({ respond: (n) => validOutput(n, { confidence: 'low' }) })), id);
    expect(video(id)).toMatchObject({ metadata_status: 'READY', approval_status: 'PENDING' });
    expect(current(id)!.needs_review).toBe(0);
  });

  it('needsReview=true also lands PENDING', async () => {
    const { id } = await oneVideo();
    await generateMetadata(deps(new FakeProvider({ respond: (n) => validOutput(n, { needsReview: true }) })), id);
    expect(video(id).approval_status).toBe('PENDING');
    expect(current(id)!.needs_review).toBe(1);
  });

  it('without AI consent no provider call happens and the video stays NOT_STARTED with a logged reason', async () => {
    setSettings(db, { aiConsent: false });
    const { id } = await oneVideo();
    const p = new FakeProvider();
    const r = await generateMetadata(deps(p), id);
    expect(r.status).toBe('skipped');
    expect(p.calls).toBe(0);
    expect(video(id).metadata_status).toBe('NOT_STARTED');
    const log = db.prepare("SELECT message FROM activity_log WHERE entity_id=? AND event_type='ai_blocked'").all(id) as { message: string }[];
    expect(log[0].message).toMatch(/consent/i);
  });

  it('regenerating only the title keeps the existing description and hashtags', async () => {
    const { id } = await oneVideo();
    const p = new FakeProvider({ respond: (n) => validOutput(n, { hashtags: [`#Tag${n}`] }) });
    await generateMetadata(deps(p), id);
    await generateMetadata(deps(p), id, { only: 'title', useCache: false });
    const m = current(id)!;
    expect(m.title).toBe('Hook 2');
    expect(m.description).toBe('Desc 1');
    expect(JSON.parse(m.hashtags_json)).toEqual(['#Shorts', '#Tag1']);
    expect(db.prepare('SELECT COUNT(*) c FROM video_metadata WHERE video_id=?').get(id)).toEqual({ c: 2 });
  });

  it('regenerating only hashtags keeps title and description', async () => {
    const { id } = await oneVideo();
    const p = new FakeProvider({ respond: (n) => validOutput(n, { hashtags: [`#Tag${n}`] }) });
    await generateMetadata(deps(p), id);
    await generateMetadata(deps(p), id, { only: 'hashtags', useCache: false });
    const m = current(id)!;
    expect([m.title, m.description]).toEqual(['Hook 1', 'Desc 1']);
    expect(JSON.parse(m.hashtags_json)).toEqual(['#Shorts', '#Tag2']);
  });

  it('a cache hit (same hash, prompt version and model) makes zero provider calls', async () => {
    const { id } = await oneVideo();
    const p = new FakeProvider();
    await generateMetadata(deps(p), id);
    db.prepare("UPDATE videos SET metadata_status='STALE' WHERE id=?").run(id);
    const r = await generateMetadata(deps(p), id);
    expect(p.calls).toBe(1);
    expect(r.status).toBe('ready');
    expect(video(id).metadata_status).toBe('READY');
  });

  it('a prompt version bump invalidates the cache', async () => {
    const { id } = await oneVideo();
    const p = new FakeProvider();
    await generateMetadata(deps(p), id);
    updateProfile(db, listProfiles(db)[0].id, { title_prompt: 'completely different' });
    await generateMetadata(deps(p), id);
    expect(p.calls).toBe(2);
    expect(current(id)!.prompt_version).toBe(2);
  });

  it('identical bytes in another folder reuse the cached result', async () => {
    const a = await oneVideo();
    const dir2 = tempDir('lt-src2-');
    fs.copyFileSync(a.file, path.join(dir2, 'copy.mp4'));
    const f2 = addFolder(db, { path: dir2 });
    await scanFolder(db, f2.id, { stableMs: 30 });
    const b = (db.prepare('SELECT id FROM videos WHERE folder_id=?').get(f2.id) as { id: number }).id;
    const p = new FakeProvider();
    await generateMetadata(deps(p), a.id);
    await generateMetadata(deps(p), b);
    expect(p.calls).toBe(1);
    expect(current(b)!.title).toBe('Hook 1');
  });

  it('cleans its temp frames and leaves the source untouched', async () => {
    const { id, file } = await oneVideo();
    const before = [fs.statSync(file).size, fs.statSync(file).mtimeMs, await sha256File(file)];
    await generateMetadata(deps(new FakeProvider()), id);
    expect(fs.readdirSync(work)).toEqual([]);
    expect([fs.statSync(file).size, fs.statSync(file).mtimeMs, await sha256File(file)]).toEqual(before);
  });

  it('retries once on invalid output, then succeeds', async () => {
    const { id } = await oneVideo();
    const p = new FakeProvider({ respond: (n) => (n === 1 ? '{"title": "cut off' : validOutput(n)) });
    expect((await generateMetadata(deps(p), id)).status).toBe('ready');
    expect(p.calls).toBe(2);
  });

  it('review focus 2: output that is invalid twice is FAILED, logged, and nothing becomes uploadable', async () => {
    const { id } = await oneVideo();
    const p = new FakeProvider({ respond: () => ({ title: 'x'.repeat(140) }) });
    const r = await generateMetadata(deps(p), id);
    expect(r.status).toBe('failed');
    expect(p.calls).toBe(2);
    expect(video(id).metadata_status).toBe('FAILED');
    expect(current(id)).toBeUndefined();
    const log = db.prepare("SELECT message FROM activity_log WHERE entity_id=? AND event_type='ai_failed'").all(id) as { message: string }[];
    expect(log[0].message).toMatch(/validation/i);
  });

  it('retries retryable provider errors then succeeds; non-retryable fails immediately', async () => {
    const a = await oneVideo({ seed: 'r1' });
    const flaky = new FakeProvider({ respond: (n) => { if (n < 3) throw new AiError('busy', true, 503); return validOutput(n); } });
    expect((await generateMetadata(deps(flaky), a.id)).status).toBe('ready');
    expect(flaky.calls).toBe(3);

    const b = await oneVideo({ seed: 'r2' });
    const denied = new FakeProvider({ respond: () => { throw new AiError('bad key', false, 401); } });
    const r = await generateMetadata(deps(denied), b.id);
    expect(r.status).toBe('failed');
    expect(denied.calls).toBe(1);
  });

  it('a file changed since discovery fails safely instead of generating for the wrong bytes', async () => {
    const { id, file } = await oneVideo();
    fs.appendFileSync(file, 'junk');
    const p = new FakeProvider();
    const r = await generateMetadata(deps(p), id);
    expect(r.status).toBe('failed');
    expect(p.calls).toBe(0);
    expect(r.error).toMatch(/changed/i);
  });
});

describe('ai worker', () => {
  it('review: runs at most 2 jobs at once and finishes all videos', async () => {
    const ids: number[] = [];
    const dir = tempDir('lt-many-');
    for (let i = 0; i < 5; i++) makeFixtureMp4(path.join(dir, `c${i}.mp4`), { seed: `s${i}` });
    const folder = addFolder(db, { path: dir });
    await scanFolder(db, folder.id, { stableMs: 30 });
    for (const r of db.prepare('SELECT id FROM videos').all() as { id: number }[]) ids.push(r.id);
    const p = new FakeProvider({ delayMs: 80 });
    const w = startAiWorker({ db, getProvider: async () => p, tempDir: () => work, pollMs: 10, retryDelayMs: 0, frameCount: 2 }, 2);
    const t0 = Date.now();
    while (Date.now() - t0 < 25000 && (db.prepare("SELECT COUNT(*) c FROM videos WHERE metadata_status='READY'").get() as { c: number }).c < 5) {
      await new Promise((r) => setTimeout(r, 25));
    }
    await w.stop();
    expect((db.prepare("SELECT COUNT(*) c FROM videos WHERE metadata_status='READY'").get() as { c: number }).c).toBe(5);
    expect(p.maxActive).toBe(2);
  }, 40000);

  it('does nothing while consent is off or no provider is configured', async () => {
    setSettings(db, { aiConsent: false });
    const { id } = await oneVideo();
    const p = new FakeProvider();
    const w = startAiWorker({ db, getProvider: async () => p, tempDir: () => work, pollMs: 10 }, 2);
    await new Promise((r) => setTimeout(r, 150));
    await w.stop();
    expect(p.calls).toBe(0);
    expect(video(id).metadata_status).toBe('NOT_STARTED');

    setSettings(db, { aiConsent: true });
    const w2 = startAiWorker({ db, getProvider: async () => null, tempDir: () => work, pollMs: 10 }, 2);
    await new Promise((r) => setTimeout(r, 150));
    await w2.stop();
    expect(video(id).metadata_status).toBe('NOT_STARTED');
  });

  it('resetStuckAi returns ANALYZING and GENERATING videos to NOT_STARTED after a crash', async () => {
    const a = await oneVideo({ seed: 'z1' });
    const b = await oneVideo({ seed: 'z2' });
    db.prepare("UPDATE videos SET metadata_status='ANALYZING' WHERE id=?").run(a.id);
    db.prepare("UPDATE videos SET metadata_status='GENERATING' WHERE id=?").run(b.id);
    resetStuckAi(db);
    expect([video(a.id).metadata_status, video(b.id).metadata_status]).toEqual(['NOT_STARTED', 'NOT_STARTED']);
  });
});

describe('metadata routes', () => {
  it('PUT saves a user edit as the current metadata; invalid edits get 400', async () => {
    const { id } = await oneVideo();
    await generateMetadata(deps(new FakeProvider()), id);
    const app = buildApp({ db, token: 't' });
    const ok = await app.inject({ method: 'PUT', url: `/api/videos/${id}/metadata`, headers: H, payload: { title: 'My own title', description: 'Mine', hashtags: ['#Mine'] } });
    expect(ok.statusCode).toBe(200);
    expect(current(id)).toMatchObject({ title: 'My own title', description: 'Mine' });
    const bad = await app.inject({ method: 'PUT', url: `/api/videos/${id}/metadata`, headers: H, payload: { title: 'x'.repeat(101), description: 'd', hashtags: [] } });
    expect(bad.statusCode).toBe(400);
    expect(current(id)!.title).toBe('My own title');
  });

  it('PUT on a video with no metadata yet creates READY manual metadata (works with AI off)', async () => {
    const { id } = await oneVideo();
    const app = buildApp({ db, token: 't' });
    const r = await app.inject({ method: 'PUT', url: `/api/videos/${id}/metadata`, headers: H, payload: { title: 'Written by hand', description: 'Mine', hashtags: ['#Shorts'] } });
    expect(r.statusCode).toBe(200);
    expect(current(id)).toMatchObject({ title: 'Written by hand', provider: 'user-edit', is_current: 1 });
    expect(video(id)).toMatchObject({ metadata_status: 'READY', approval_status: 'NOT_REQUIRED' });
  });

  it('manual metadata in a manual-review folder stays PENDING', async () => {
    const { id, folderId } = await oneVideo();
    updateFolder(db, folderId, { auto_publish: 0 });
    const app = buildApp({ db, token: 't' });
    await app.inject({ method: 'PUT', url: `/api/videos/${id}/metadata`, headers: H, payload: { title: 'T', description: 'D', hashtags: [] } });
    expect(video(id).approval_status).toBe('PENDING');
  });

  it('POST regenerate with only=title uses the provider and keeps the rest', async () => {
    const { id } = await oneVideo();
    const p = new FakeProvider();
    await generateMetadata(deps(p), id);
    const app = buildApp({ db, token: 't', getProvider: async () => p });
    const r = await app.inject({ method: 'POST', url: `/api/videos/${id}/regenerate`, headers: H, payload: { only: 'title' } });
    expect(r.statusCode).toBe(200);
    expect(current(id)).toMatchObject({ title: 'Hook 2', description: 'Desc 1' });
  });

  it('approve and reject set approval for READY videos in bulk', async () => {
    const a = await oneVideo({ seed: 'b1' });
    const b = await oneVideo({ seed: 'b2' });
    updateFolder(db, a.folderId, { auto_publish: 0 });
    updateFolder(db, b.folderId, { auto_publish: 0 });
    const p = new FakeProvider();
    await generateMetadata(deps(p), a.id);
    await generateMetadata(deps(p), b.id);
    const app = buildApp({ db, token: 't' });
    await app.inject({ method: 'POST', url: '/api/videos/approve', headers: H, payload: { ids: [a.id] } });
    await app.inject({ method: 'POST', url: '/api/videos/reject', headers: H, payload: { ids: [b.id] } });
    expect([video(a.id).approval_status, video(b.id).approval_status]).toEqual(['APPROVED', 'REJECTED']);
  });
});
