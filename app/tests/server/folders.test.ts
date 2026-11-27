import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, type Db } from '../../src/server/db/db.js';
import { buildApp } from '../../src/server/app.js';
import { addFolder, listFolders, removeFolder, updateFolder } from '../../src/server/folders/folderRepo.js';

const H = { 'x-localtube-token': 't' };
let db: Db;
beforeEach(() => {
  db = openDb(':memory:');
});

describe('folderRepo', () => {
  it('returns the existing row when the same path is added twice (case-insensitive)', () => {
    const a = addFolder(db, { path: 'D:\\Clips' });
    const b = addFolder(db, { path: 'd:\\clips' });
    expect(b.id).toBe(a.id);
    expect(listFolders(db)).toHaveLength(1);
  });

  it('applies defaults: recursive, no monitor, auto-publish, public', () => {
    const f = addFolder(db, { path: 'D:\\Clips' });
    expect(f).toMatchObject({ recursive_scan: 1, monitor_enabled: 0, auto_publish: 1, default_visibility: 'public', display_name: 'Clips' });
  });

  it('round-trips a path with spaces, non-ASCII and #', () => {
    const f = addFolder(db, { path: 'D:\\My Clips\\gäme #1' });
    expect(listFolders(db)[0].path).toBe('D:\\My Clips\\gäme #1');
    expect(f.display_name).toBe('gäme #1');
  });

  it('removeFolder keeps videos and upload jobs', () => {
    const f = addFolder(db, { path: 'D:\\Clips' });
    db.prepare("INSERT INTO videos(folder_id,file_path,filename) VALUES(?,?,?)").run(f.id, 'D:\\Clips\\a.mp4', 'a.mp4');
    db.prepare("INSERT INTO upload_jobs(video_id,status) VALUES(1,'UPLOAD_COMPLETE')").run();
    removeFolder(db, f.id);
    expect(db.prepare('SELECT COUNT(*) c FROM videos').get()).toEqual({ c: 1 });
    expect(db.prepare('SELECT COUNT(*) c FROM upload_jobs').get()).toEqual({ c: 1 });
    expect(listFolders(db)).toHaveLength(0);
  });

  it('re-adding a removed folder re-enables it', () => {
    const f = addFolder(db, { path: 'D:\\Clips' });
    removeFolder(db, f.id);
    const again = addFolder(db, { path: 'D:\\Clips' });
    expect(again.id).toBe(f.id);
    expect(listFolders(db)).toHaveLength(1);
  });

  it('updateFolder patches settings', () => {
    const f = addFolder(db, { path: 'D:\\Clips' });
    const u = updateFolder(db, f.id, { auto_publish: 0, default_visibility: 'unlisted' });
    expect(u).toMatchObject({ auto_publish: 0, default_visibility: 'unlisted' });
  });
});

describe('folder routes', () => {
  it('POST /api/folders rejects a non-existent path with 400', async () => {
    const app = buildApp({ db, token: 't' });
    const r = await app.inject({ method: 'POST', url: '/api/folders', headers: H, payload: { path: 'Z:\\definitely\\not\\here' } });
    expect(r.statusCode).toBe(400);
  });

  it('POST /api/folders adds an existing directory', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt gäme #'));
    const app = buildApp({ db, token: 't' });
    const r = await app.inject({ method: 'POST', url: '/api/folders', headers: H, payload: { path: dir } });
    expect(r.statusCode).toBe(200);
    expect(r.json().path).toBe(dir);
    const list = await app.inject({ method: 'GET', url: '/api/folders', headers: H });
    expect(list.json()).toHaveLength(1);
  });

  it('POST /api/folders/pick uses the injected picker and adds the result', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-pick-'));
    const app = buildApp({ db, token: 't', pickFolder: async () => dir });
    const r = await app.inject({ method: 'POST', url: '/api/folders/pick', headers: H });
    expect(r.statusCode).toBe(200);
    expect(r.json().path).toBe(dir);
  });

  it('pick cancelled returns 204 and adds nothing', async () => {
    const app = buildApp({ db, token: 't', pickFolder: async () => null });
    const r = await app.inject({ method: 'POST', url: '/api/folders/pick', headers: H });
    expect(r.statusCode).toBe(204);
    expect(listFolders(db)).toHaveLength(0);
  });

  it('DELETE removes the folder from the list but keeps files untouched', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-del-'));
    fs.writeFileSync(path.join(dir, 'a.mp4'), 'x');
    const app = buildApp({ db, token: 't' });
    const added = (await app.inject({ method: 'POST', url: '/api/folders', headers: H, payload: { path: dir } })).json();
    const r = await app.inject({ method: 'DELETE', url: `/api/folders/${added.id}`, headers: H });
    expect(r.statusCode).toBe(200);
    expect(fs.existsSync(path.join(dir, 'a.mp4'))).toBe(true);
  });
});
