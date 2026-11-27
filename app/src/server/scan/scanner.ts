import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/db.js';
import type { Folder } from '../folders/folderRepo.js';
import { probeVideo, type ProbeFn } from './probe.js';
import { isStable } from './stability.js';

export interface ScanResult {
  found: number;
  added: number;
  changed: number;
  waiting: number;
  unavailable: number;
}

export interface ScanOptions {
  stableMs?: number;
  probe?: ProbeFn;
}

interface Candidate {
  file: string;
  size: number;
  mtimeMs: number;
}
interface VideoRow {
  id: number;
  file_path: string;
  file_size_bytes: number | null;
  modified_at: number | null;
  discovery_status: string;
  metadata_status: string;
}

const SKIP_DIRS = new Set(['$recycle.bin', 'system volume information']);
/** Statuses that need no re-processing when path, size and mtime are unchanged. */
const SETTLED = new Set(['VALID', 'DUPLICATE', 'SKIPPED', 'INVALID']);

export function isCandidateName(name: string): boolean {
  if (name.startsWith('.') || name.startsWith('~$')) return false;
  return name.toLowerCase().endsWith('.mp4');
}

async function* walk(dir: string, recursive: boolean): AsyncGenerator<string> {
  let handle: fs.Dir;
  try {
    handle = await fs.promises.opendir(dir);
  } catch {
    return; // inaccessible: skip quietly, records are untouched
  }
  for await (const entry of handle) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive && !entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name.toLowerCase())) yield* walk(full, recursive);
    } else if (entry.isFile() && isCandidateName(entry.name)) {
      yield full;
    }
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

export async function scanFolder(db: Db, folderId: number, opts: ScanOptions = {}): Promise<ScanResult> {
  const stableMs = opts.stableMs ?? 2000;
  const probe = opts.probe ?? probeVideo;
  const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(folderId) as Folder | undefined;
  if (!folder) throw new Error(`folder ${folderId} not found`);
  const result: ScanResult = { found: 0, added: 0, changed: 0, waiting: 0, unavailable: 0 };

  const existing = new Map((db.prepare('SELECT * FROM videos WHERE folder_id = ?').all(folderId) as VideoRow[]).map((r) => [r.file_path, r]));
  const markUnavailable = db.prepare(
    "UPDATE videos SET discovery_status='UNAVAILABLE', updated_at=datetime('now') WHERE id = ? AND discovery_status != 'UNAVAILABLE'",
  );

  let dirOk = false;
  try {
    dirOk = (await fs.promises.stat(folder.path)).isDirectory();
  } catch {
    dirOk = false;
  }
  if (!dirOk) {
    for (const row of existing.values()) result.unavailable += markUnavailable.run(row.id).changes;
    return result;
  }

  const foreignOwner = db.prepare('SELECT 1 FROM videos WHERE file_path = ?');
  const seen = new Set<string>();
  const work: { c: Candidate; row?: VideoRow }[] = [];
  for await (const file of walk(folder.path, !!folder.recursive_scan)) {
    let st: fs.Stats;
    try {
      st = await fs.promises.stat(file);
    } catch {
      continue;
    }
    const row = existing.get(file);
    // Overlapping folders (a parent and one of its subfolders): the first folder to record a file owns it.
    if (!row && foreignOwner.get(file)) continue;
    seen.add(file);
    result.found++;
    const c: Candidate = { file, size: st.size, mtimeMs: Math.trunc(st.mtimeMs) };
    const unchanged = row && row.file_size_bytes === c.size && row.modified_at === c.mtimeMs;
    if (unchanged && SETTLED.has(row.discovery_status)) continue;
    work.push({ c, row });
  }

  for (const row of existing.values()) {
    if (!seen.has(row.file_path)) result.unavailable += markUnavailable.run(row.id).changes;
  }

  const insert = db.prepare(
    "INSERT INTO videos(folder_id,file_path,filename,file_size_bytes,modified_at,discovery_status) VALUES(?,?,?,?,?,'WAITING_FOR_STABLE_FILE')",
  );
  const markChanged = db.prepare(
    `UPDATE videos SET file_size_bytes=?, modified_at=?, content_hash=NULL, discovery_status='WAITING_FOR_STABLE_FILE',
       metadata_status = CASE WHEN metadata_status='READY' THEN 'STALE' ELSE metadata_status END, updated_at=datetime('now') WHERE id=?`,
  );
  const setStatus = db.prepare("UPDATE videos SET discovery_status=?, updated_at=datetime('now') WHERE id=?");
  const setProbe = db.prepare(
    `UPDATE videos SET discovery_status='VALID', duration_seconds=?, width=?, height=?, frame_rate=?, video_codec=?, audio_codec=?,
       shorts_warning=?, updated_at=datetime('now') WHERE id=?`,
  );

  const ids: number[] = [];
  const isNew: boolean[] = [];
  for (const { c, row } of work) {
    if (!row) {
      ids.push(Number(insert.run(folderId, c.file, path.basename(c.file), c.size, c.mtimeMs).lastInsertRowid));
      isNew.push(true);
    } else {
      const wasChanged = row.file_size_bytes !== c.size || row.modified_at !== c.mtimeMs;
      if (wasChanged) {
        markChanged.run(c.size, c.mtimeMs, row.id);
        result.changed++;
      } else {
        setStatus.run('WAITING_FOR_STABLE_FILE', row.id);
      }
      ids.push(row.id);
      isNew.push(false);
    }
  }

  await mapLimit(work.map((w, i) => ({ c: w.c, i })), 4, async ({ c, i }) => {
    const id = ids[i];
    if (!(await isStable(c.file, stableMs))) {
      result.waiting++;
      return;
    }
    if (c.size === 0) {
      setStatus.run('INVALID', id);
      return;
    }
    try {
      const p = await probe(c.file);
      setProbe.run(p.durationSec, p.width, p.height, p.fps, p.videoCodec, p.audioCodec, p.shortsWarning, id);
      if (isNew[i]) result.added++;
    } catch {
      setStatus.run('INVALID', id);
    }
  });

  db.prepare("UPDATE folders SET last_scan_at = datetime('now') WHERE id = ?").run(folderId);
  return result;
}
