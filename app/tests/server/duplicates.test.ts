import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { openDb, type Db } from '../../src/server/db/db.js';
import { addFolder } from '../../src/server/folders/folderRepo.js';
import { sha256File, fingerprintVideo } from '../../src/server/scan/fingerprint.js';
import { resolveDuplicate, allowRepublish } from '../../src/server/scan/duplicates.js';
import { tempDir } from '../fixtures/make-fixtures.js';

let db: Db;
beforeEach(() => {
  db = openDb(':memory:');
});

function addVideo(dirPath: string, name: string, content: string | Buffer): number {
  const f = addFolder(db, { path: dirPath });
  const file = path.join(dirPath, name);
  fs.writeFileSync(file, content);
  const st = fs.statSync(file);
  const r = db
    .prepare("INSERT INTO videos(folder_id,file_path,filename,file_size_bytes,modified_at,discovery_status) VALUES(?,?,?,?,?,'VALID')")
    .run(f.id, file, name, st.size, Math.trunc(st.mtimeMs));
  return Number(r.lastInsertRowid);
}
const status = (id: number) => (db.prepare('SELECT discovery_status s FROM videos WHERE id=?').get(id) as { s: string }).s;

describe('sha256File', () => {
  it('matches the known digest of "abc"', async () => {
    const f = path.join(tempDir(), 'a.bin');
    fs.writeFileSync(f, 'abc');
    expect(await sha256File(f)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('streams a 200 MB file without holding it in memory', async () => {
    const f = path.join(tempDir(), 'big.bin');
    const fd = fs.openSync(f, 'w');
    fs.ftruncateSync(fd, 200 * 1024 * 1024);
    fs.closeSync(fd);
    const base = process.memoryUsage();
    let peak = 0;
    const t = setInterval(() => {
      const m = process.memoryUsage();
      peak = Math.max(peak, m.heapUsed + m.arrayBuffers - base.heapUsed - base.arrayBuffers);
    }, 5);
    try {
      await sha256File(f);
    } finally {
      clearInterval(t);
    }
    expect(peak).toBeLessThan(50 * 1024 * 1024);
  }, 60000);
});

describe('duplicate detection', () => {
  it('flags identical bytes in a second folder as DUPLICATE, keeping the first', async () => {
    const a = addVideo(tempDir(), 'one.mp4', 'same bytes');
    const b = addVideo(tempDir(), 'two.mp4', 'same bytes');
    await fingerprintVideo(db, a);
    await fingerprintVideo(db, b);
    expect(resolveDuplicate(db, a)).toBe('unique');
    expect(resolveDuplicate(db, b)).toBe('duplicate');
    expect(status(a)).toBe('VALID');
    expect(status(b)).toBe('DUPLICATE');
  });

  it('does not treat same name with different bytes as a duplicate', async () => {
    const a = addVideo(tempDir(), 'clip.mp4', 'bytes A');
    const b = addVideo(tempDir(), 'clip.mp4', 'bytes B');
    await fingerprintVideo(db, a);
    await fingerprintVideo(db, b);
    expect(resolveDuplicate(db, a)).toBe('unique');
    expect(resolveDuplicate(db, b)).toBe('unique');
  });

  it('flags a file whose twin already has an upload job even if the twin was added later', async () => {
    const dir = tempDir();
    const a = addVideo(dir, 'one.mp4', 'same');
    const b = addVideo(tempDir(), 'two.mp4', 'same');
    await fingerprintVideo(db, a);
    await fingerprintVideo(db, b);
    db.prepare("INSERT INTO upload_jobs(video_id,status) VALUES(?, 'UPLOAD_COMPLETE')").run(b);
    expect(resolveDuplicate(db, a)).toBe('duplicate');
  });

  it('fingerprintVideo stores the hash and throws if the file changes while hashing is requested for a stale row', async () => {
    const a = addVideo(tempDir(), 'one.mp4', 'abc');
    const h = await fingerprintVideo(db, a);
    expect((db.prepare('SELECT content_hash h FROM videos WHERE id=?').get(a) as { h: string }).h).toBe(h);
    const row = db.prepare('SELECT file_path p FROM videos WHERE id=?').get(a) as { p: string };
    fs.writeFileSync(row.p, 'changed content now');
    await expect(fingerprintVideo(db, a)).rejects.toThrow(/changed/i);
  });

  it('resolveDuplicate throws if the video has no hash yet', () => {
    const a = addVideo(tempDir(), 'one.mp4', 'abc');
    expect(() => resolveDuplicate(db, a)).toThrow(/hash/i);
  });

  it('allowRepublish clears DUPLICATE, survives re-resolution and writes an audit row', async () => {
    const a = addVideo(tempDir(), 'one.mp4', 'same');
    const b = addVideo(tempDir(), 'two.mp4', 'same');
    await fingerprintVideo(db, a);
    await fingerprintVideo(db, b);
    expect(resolveDuplicate(db, b)).toBe('duplicate');
    allowRepublish(db, b);
    expect(status(b)).toBe('VALID');
    expect(resolveDuplicate(db, b)).toBe('unique');
    expect(status(b)).toBe('VALID');
    const log = db.prepare("SELECT * FROM activity_log WHERE entity_type='video' AND entity_id=? AND event_type='republish_allowed'").all(b);
    expect(log).toHaveLength(1);
  });
});
