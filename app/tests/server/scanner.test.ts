import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { openDb, type Db } from '../../src/server/db/db.js';
import { addFolder, updateFolder } from '../../src/server/folders/folderRepo.js';
import { scanFolder } from '../../src/server/scan/scanner.js';
import { probeVideo, type ProbeResult } from '../../src/server/scan/probe.js';
import { isStable } from '../../src/server/scan/stability.js';
import { fixture, tempDir } from '../fixtures/make-fixtures.js';

let db: Db;
beforeEach(() => {
  db = openDb(':memory:');
});

const fakeProbe = (calls: string[] = []) => async (file: string): Promise<ProbeResult> => {
  calls.push(file);
  return { durationSec: 10, width: 1080, height: 1920, fps: 30, videoCodec: 'h264', audioCodec: 'aac', shortsWarning: null };
};
const rows = () => db.prepare('SELECT * FROM videos ORDER BY file_path').all() as Record<string, any>[];

describe('isStable', () => {
  it('is true for a quiet file and false while it is growing', async () => {
    const dir = tempDir();
    const f = path.join(dir, 'a.mp4');
    fs.writeFileSync(f, 'x');
    expect(await isStable(f, 60)).toBe(true);
    const t = setInterval(() => fs.appendFileSync(f, 'y'), 10);
    try {
      expect(await isStable(f, 100)).toBe(false);
    } finally {
      clearInterval(t);
    }
  });

  it('is false for a missing file', async () => {
    expect(await isStable(path.join(tempDir(), 'nope.mp4'), 20)).toBe(false);
  });
});

describe('probeVideo', () => {
  it('reads a real vertical short', async () => {
    const p = await probeVideo(fixture('short'));
    expect(p).toMatchObject({ width: 270, height: 480, videoCodec: 'h264', audioCodec: 'aac', shortsWarning: null });
    expect(p.durationSec).toBeGreaterThan(0.5);
    expect(p.fps).toBeCloseTo(30, 0);
  });

  it('warns when the video is landscape', async () => {
    const p = await probeVideo(fixture('landscape'));
    expect(p.shortsWarning).toMatch(/vertical|square/i);
  });

  it('rejects a corrupt file', async () => {
    const f = path.join(tempDir(), 'bad.mp4');
    fs.writeFileSync(f, 'this is not a video');
    await expect(probeVideo(f)).rejects.toThrow();
  });
});

describe('scanFolder', () => {
  it('review focus 1: a file still being copied is not probed or counted as added', async () => {
    const dir = tempDir();
    const f = path.join(dir, 'growing.mp4');
    fs.writeFileSync(f, 'x');
    const folder = addFolder(db, { path: dir });
    const t = setInterval(() => fs.appendFileSync(f, 'y'), 10);
    const calls: string[] = [];
    try {
      const r = await scanFolder(db, folder.id, { stableMs: 100, probe: fakeProbe(calls) });
      expect(r).toMatchObject({ found: 1, added: 0, waiting: 1 });
    } finally {
      clearInterval(t);
    }
    expect(calls).toHaveLength(0);
    expect(rows()[0].discovery_status).toBe('WAITING_FOR_STABLE_FILE');
  });

  it('a waiting file becomes VALID on a later scan once it stops changing', async () => {
    const dir = tempDir();
    const f = path.join(dir, 'a.mp4');
    fs.writeFileSync(f, 'x');
    const folder = addFolder(db, { path: dir });
    const t = setInterval(() => fs.appendFileSync(f, 'y'), 10);
    await scanFolder(db, folder.id, { stableMs: 100, probe: fakeProbe() });
    clearInterval(t);
    await scanFolder(db, folder.id, { stableMs: 60, probe: fakeProbe() });
    expect(rows()[0].discovery_status).toBe('VALID');
  });

  it('recursion on finds nested files, off does not', async () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'a.mp4'), 'x');
    fs.writeFileSync(path.join(dir, 'sub', 'b.mp4'), 'x');
    const folder = addFolder(db, { path: dir });
    expect((await scanFolder(db, folder.id, { stableMs: 30, probe: fakeProbe() })).found).toBe(2);
    updateFolder(db, folder.id, { recursive_scan: 0 });
    expect((await scanFolder(db, folder.id, { stableMs: 30, probe: fakeProbe() })).found).toBe(1);
  });

  it('matches .MP4 and ignores temp, hidden and non-mp4 files', async () => {
    const dir = tempDir();
    for (const n of ['A.MP4', '~$a.mp4', '.hidden.mp4', 'b.mp4.part', 'c.tmp', 'd.mov', 'notes.txt']) fs.writeFileSync(path.join(dir, n), 'x');
    const folder = addFolder(db, { path: dir });
    const r = await scanFolder(db, folder.id, { stableMs: 30, probe: fakeProbe() });
    expect(r.found).toBe(1);
    expect(rows().map((x) => x.filename)).toEqual(['A.MP4']);
  });

  it('a rescan with no changes does not probe again', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'a.mp4'), 'x');
    const folder = addFolder(db, { path: dir });
    const calls: string[] = [];
    await scanFolder(db, folder.id, { stableMs: 30, probe: fakeProbe(calls) });
    await scanFolder(db, folder.id, { stableMs: 30, probe: fakeProbe(calls) });
    expect(calls).toHaveLength(1);
    expect(rows()).toHaveLength(1);
  });

  it('modifying a file after metadata is READY makes the metadata STALE and clears the hash', async () => {
    const dir = tempDir();
    const f = path.join(dir, 'a.mp4');
    fs.writeFileSync(f, 'x');
    const folder = addFolder(db, { path: dir });
    await scanFolder(db, folder.id, { stableMs: 30, probe: fakeProbe() });
    db.prepare("UPDATE videos SET metadata_status='READY', content_hash='abc'").run();
    fs.writeFileSync(f, 'xxxxxxxx');
    const r = await scanFolder(db, folder.id, { stableMs: 30, probe: fakeProbe() });
    expect(r.changed).toBe(1);
    expect(rows()[0]).toMatchObject({ metadata_status: 'STALE', content_hash: null, discovery_status: 'VALID' });
  });

  it('review focus 5: missing folder keeps records and marks them UNAVAILABLE', async () => {
    const dir = path.join(tempDir(), 'My Clips', 'gäme #1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.mp4'), 'x');
    const folder = addFolder(db, { path: dir });
    expect((await scanFolder(db, folder.id, { stableMs: 30, probe: fakeProbe() })).found).toBe(1);
    fs.rmSync(dir, { recursive: true });
    const r = await scanFolder(db, folder.id, { stableMs: 30, probe: fakeProbe() });
    expect(r.unavailable).toBe(1);
    expect(rows()).toHaveLength(1);
    expect(rows()[0].discovery_status).toBe('UNAVAILABLE');
  });

  it('an unavailable video comes back VALID when the file returns', async () => {
    const dir = tempDir();
    const f = path.join(dir, 'a.mp4');
    fs.writeFileSync(f, 'x');
    const folder = addFolder(db, { path: dir });
    await scanFolder(db, folder.id, { stableMs: 30, probe: fakeProbe() });
    fs.rmSync(f);
    await scanFolder(db, folder.id, { stableMs: 30, probe: fakeProbe() });
    fs.writeFileSync(f, 'x');
    await scanFolder(db, folder.id, { stableMs: 30, probe: fakeProbe() });
    expect(rows()[0].discovery_status).toBe('VALID');
  });

  it('a 0-byte file is INVALID and never probed', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'empty.mp4'), '');
    const folder = addFolder(db, { path: dir });
    const calls: string[] = [];
    await scanFolder(db, folder.id, { stableMs: 30, probe: fakeProbe(calls) });
    expect(rows()[0].discovery_status).toBe('INVALID');
    expect(calls).toHaveLength(0);
  });

  it('a file the probe rejects is INVALID', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'bad.mp4'), 'not a video');
    const folder = addFolder(db, { path: dir });
    await scanFolder(db, folder.id, { stableMs: 30, probe: probeVideo });
    expect(rows()[0].discovery_status).toBe('INVALID');
  });

  it('records probe properties and updates last_scan_at', async () => {
    const dir = tempDir();
    fs.copyFileSync(fixture('short'), path.join(dir, 'real.mp4'));
    const folder = addFolder(db, { path: dir });
    await scanFolder(db, folder.id, { stableMs: 30 });
    expect(rows()[0]).toMatchObject({ discovery_status: 'VALID', width: 270, height: 480, video_codec: 'h264', audio_codec: 'aac' });
    expect((db.prepare('SELECT last_scan_at FROM folders').get() as any).last_scan_at).toBeTruthy();
  });

  it('never modifies source files', async () => {
    const dir = tempDir();
    const f = path.join(dir, 'a.mp4');
    fs.copyFileSync(fixture('short'), f);
    const before = fs.statSync(f);
    const folder = addFolder(db, { path: dir });
    await scanFolder(db, folder.id, { stableMs: 30 });
    const after = fs.statSync(f);
    expect([after.size, after.mtimeMs]).toEqual([before.size, before.mtimeMs]);
  });
});
