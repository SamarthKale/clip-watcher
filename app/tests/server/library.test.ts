import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, type Db } from '../../src/server/db/db.js';
import { buildApp } from '../../src/server/app.js';
import { addFolder, listFolders } from '../../src/server/folders/folderRepo.js';
import { ensureLibraryFolder, libraryFolder, syncUploadState, uploadState } from '../../src/server/library/library.js';
import { getSettings } from '../../src/server/settings.js';

const H = { 'x-localtube-token': 't' };
let db: Db;
let root: string;
beforeEach(() => {
  db = openDb(':memory:');
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function stream(name = 'abc__live', clips: object[] = [{ file: '01_a.mp4', post_title: 'T' }]) {
  const dir = path.join(root, '2026-11-18', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '01_a.mp4'), 'x');
  fs.writeFileSync(path.join(dir, 'clips.json'), JSON.stringify({ schema: 2, clips }));
  return dir;
}
function addVideo(folderId: number, file: string, cols: Record<string, string> = {}) {
  const info = db.prepare('INSERT INTO videos(folder_id,file_path,filename) VALUES(?,?,?)').run(folderId, file, path.basename(file));
  const id = Number(info.lastInsertRowid);
  for (const [k, v] of Object.entries(cols)) db.prepare(`UPDATE videos SET ${k} = ? WHERE id = ?`).run(v, id);
  return id;
}

describe('library folder', () => {
  it('is registered once, recursive, monitored, and starts in review mode (private)', () => {
    const f = ensureLibraryFolder(db, root);
    expect(f).toMatchObject({ recursive_scan: 1, monitor_enabled: 1, auto_publish: 0, default_visibility: 'private', display_name: 'Spikecut Shorts' });
    ensureLibraryFolder(db, root);
    expect(listFolders(db)).toHaveLength(1);
    expect(getSettings(db).libraryDir).toBe(root);
    expect(libraryFolder(db)?.id).toBe(f.id);
  });

  it('follows the publish mode and visibility settings, and only touches the library folder', async () => {
    const other = addFolder(db, { path: path.join(root, 'other') });
    ensureLibraryFolder(db, path.join(root, 'lib'));
    const app = buildApp({ db, token: 't' });
    let r = await app.inject({ method: 'PUT', url: '/api/settings', headers: H, payload: { publishMode: 'auto', autoVisibility: 'unlisted' } });
    expect(r.statusCode).toBe(200);
    expect(libraryFolder(db)).toMatchObject({ auto_publish: 1, default_visibility: 'unlisted' });
    expect(listFolders(db).find((f) => f.id === other.id)).toMatchObject({ auto_publish: 1, default_visibility: 'public' });
    r = await app.inject({ method: 'PUT', url: '/api/settings', headers: H, payload: { publishMode: 'review' } });
    expect(libraryFolder(db)?.auto_publish).toBe(0);
    r = await app.inject({ method: 'PUT', url: '/api/settings', headers: H, payload: { publishMode: 'bogus' } });
    expect(r.statusCode).toBe(400);
    await app.close();
  });

  it('review mode keeps a new Short waiting for approval', async () => {
    const { applyManifest, parseManifest } = await import('../../src/server/manifest/manifest.js');
    const dir = stream();
    const f = ensureLibraryFolder(db, root);
    const vid = addVideo(f.id, path.join(dir, '01_a.mp4'));
    const clips = parseManifest(JSON.parse(fs.readFileSync(path.join(dir, 'clips.json'), 'utf8')));
    applyManifest(db, f.id, clips);
    expect(db.prepare('SELECT approval_status a, metadata_status m FROM videos WHERE id = ?').get(vid)).toEqual({ a: 'PENDING', m: 'READY' });
  });
});

describe('upload state written back to clips.json', () => {
  it('maps every state', () => {
    const base = { file_path: 'x', upload_status: 'NOT_QUEUED', processing_status: 'NOT_CHECKED', youtube_privacy: null, approval_status: 'PENDING', youtube_video_id: null, upload_completed_at: null };
    expect(uploadState(base)).toBeNull();
    expect(uploadState({ ...base, approval_status: 'REJECTED' })).toEqual({ status: 'discarded' });
    expect(uploadState({ ...base, upload_status: 'QUEUED' })?.status).toBe('queued');
    expect(uploadState({ ...base, upload_status: 'UPLOAD_COMPLETE', processing_status: 'PROCESSING', youtube_video_id: 'abc' })).toMatchObject({ status: 'uploaded', url: 'https://www.youtube.com/watch?v=abc' });
    expect(uploadState({ ...base, upload_status: 'UPLOAD_COMPLETE', processing_status: 'READY', youtube_video_id: 'abc' })?.status).toBe('published');
    expect(uploadState({ ...base, upload_status: 'UPLOAD_OUTCOME_UNKNOWN' })?.status).toBe('needs_attention');
  });

  it('writes uploaded Shorts into clips.json once, and leaves everything else alone', () => {
    const dir = stream('abc__live', [{ file: '01_a.mp4', post_title: 'T' }, { file: '02_b.mp4', post_title: 'U' }]);
    const f = ensureLibraryFolder(db, root);
    const v1 = addVideo(f.id, path.join(dir, '01_a.mp4'), { upload_status: 'UPLOAD_COMPLETE', processing_status: 'READY', youtube_privacy: 'private' });
    db.prepare('INSERT INTO upload_jobs(video_id,status,youtube_video_id,upload_completed_at) VALUES(?,?,?,?)').run(v1, 'UPLOAD_COMPLETE', 'yt123', '2026-11-18 10:00:00');
    addVideo(f.id, path.join(dir, '02_b.mp4')); // untouched: NOT_QUEUED
    expect(syncUploadState(db)).toBe(1);
    const doc = JSON.parse(fs.readFileSync(path.join(dir, 'clips.json'), 'utf8'));
    expect(doc.clips[0].upload).toMatchObject({ status: 'published', youtube_video_id: 'yt123', privacy: 'private' });
    expect(doc.clips[1].upload).toBeUndefined();
    expect(doc.clips[0].post_title).toBe('T'); // the rest of the entry is preserved
    expect(syncUploadState(db)).toBe(0); // nothing changed, nothing rewritten
  });

  it('marks a rejected Short discarded', () => {
    const dir = stream();
    const f = ensureLibraryFolder(db, root);
    addVideo(f.id, path.join(dir, '01_a.mp4'), { approval_status: 'REJECTED' });
    syncUploadState(db);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'clips.json'), 'utf8')).clips[0].upload).toEqual({ status: 'discarded' });
  });

  it('never touches a folder that is not the library, and skips unreadable clips.json', () => {
    const lib = path.join(root, 'lib');
    fs.mkdirSync(lib);
    ensureLibraryFolder(db, lib);
    const outsideDir = path.join(root, 'outside');
    fs.mkdirSync(outsideDir);
    fs.writeFileSync(path.join(outsideDir, 'clips.json'), JSON.stringify({ clips: [{ file: 'a.mp4' }] }));
    const f2 = addFolder(db, { path: outsideDir });
    addVideo(f2.id, path.join(outsideDir, 'a.mp4'), { upload_status: 'UPLOAD_COMPLETE' });
    const badDir = path.join(lib, 'bad__live');
    fs.mkdirSync(badDir);
    fs.writeFileSync(path.join(badDir, 'clips.json'), '{not json');
    const f1 = libraryFolder(db)!;
    addVideo(f1.id, path.join(badDir, 'x.mp4'), { upload_status: 'UPLOAD_COMPLETE' });
    expect(syncUploadState(db)).toBe(0);
    expect(fs.readFileSync(path.join(badDir, 'clips.json'), 'utf8')).toBe('{not json');
    expect(JSON.parse(fs.readFileSync(path.join(outsideDir, 'clips.json'), 'utf8')).clips[0].upload).toBeUndefined();
  });

  it('is a no-op without a library folder', () => {
    expect(syncUploadState(db)).toBe(0);
  });
});
