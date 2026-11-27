import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/db.js';
import { addFolder, listFolders, normalizeFolderPath, type Folder } from '../folders/folderRepo.js';
import { log } from '../log.js';
import { getSettings } from '../settings.js';

/**
 * The Clip Watcher Shorts library (Shorts/<date>/<channel>__live|vod/) is registered once as a
 * recursive watched folder, so every stream folder the pipeline creates is found by the normal
 * scan loop. Nobody picks folders by hand.
 */
export function libraryFolder(db: Db): Folder | undefined {
  const dir = getSettings(db).libraryDir;
  if (!dir) return undefined;
  const want = normalizeFolderPath(dir).toLowerCase();
  return listFolders(db).find((f) => normalizeFolderPath(f.path).toLowerCase() === want);
}

/** Registers the library folder (creating it if needed) and applies the publish mode to it. */
export function ensureLibraryFolder(db: Db, dir: string): Folder {
  fs.mkdirSync(dir, { recursive: true });
  const f = addFolder(db, { path: dir, recursive: true });
  const stored = db.prepare("SELECT value FROM settings WHERE key = 'libraryDir'").get() as { value: string } | undefined;
  if (!stored || JSON.parse(stored.value) !== dir) {
    db.prepare("INSERT INTO settings(key, value) VALUES('libraryDir', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(dir));
  }
  db.prepare("UPDATE folders SET display_name = 'Clip Watcher Shorts', monitor_enabled = 1 WHERE id = ?").run(f.id);
  applyPublishMode(db);
  return libraryFolder(db) ?? f;
}

/**
 * review: auto_publish off, so finished Shorts wait for approval. auto: on, with the chosen visibility.
 * Only the library folder is touched, and only future decisions change: jobs already queued keep
 * the visibility they were queued with.
 */
export function applyPublishMode(db: Db): void {
  const f = libraryFolder(db);
  if (!f) return;
  const s = getSettings(db);
  db.prepare("UPDATE folders SET auto_publish = ?, default_visibility = ?, updated_at = datetime('now') WHERE id = ?").run(
    s.publishMode === 'auto' ? 1 : 0,
    s.autoVisibility,
    f.id,
  );
}

interface Row {
  file_path: string;
  upload_status: string;
  processing_status: string;
  youtube_privacy: string | null;
  approval_status: string;
  youtube_video_id: string | null;
  upload_completed_at: string | null;
}

/** What Clip Watcher's storage manager needs to know about a Short, in plain words. */
export function uploadState(r: Row): { status: string; youtube_video_id?: string; url?: string; privacy?: string; processing?: string } | null {
  if (r.approval_status === 'REJECTED' || r.upload_status === 'CANCELLED') return { status: 'discarded' };
  if (r.upload_status === 'NOT_QUEUED') return null;
  const base = {
    ...(r.youtube_video_id ? { youtube_video_id: r.youtube_video_id, url: `https://www.youtube.com/watch?v=${r.youtube_video_id}` } : {}),
    ...(r.youtube_privacy ? { privacy: r.youtube_privacy } : {}),
    processing: r.processing_status,
  };
  if (r.upload_status === 'UPLOAD_COMPLETE') return { status: r.processing_status === 'READY' ? 'published' : 'uploaded', ...base };
  if (r.upload_status === 'FAILED_PERMANENTLY' || r.upload_status === 'UPLOAD_OUTCOME_UNKNOWN') return { status: 'needs_attention', ...base };
  return { status: 'queued', ...base };
}

function writeJsonAtomic(file: string, data: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * Writes each library Short's upload state into its folder's clips.json ("upload": {...}) so Clip
 * Watcher's storage manager can tell uploaded or discarded Shorts from the rest. Only the library
 * folder is touched, only entries whose state changed are rewritten, and a clips.json that cannot
 * be read is left alone. Returns the number of entries updated.
 */
export function syncUploadState(db: Db): number {
  const lib = libraryFolder(db);
  if (!lib) return 0;
  const rows = db
    .prepare(
      `SELECT v.file_path, v.upload_status, v.processing_status, v.youtube_privacy, v.approval_status,
              j.youtube_video_id, j.upload_completed_at
         FROM videos v
         LEFT JOIN upload_jobs j ON j.video_id = v.id AND j.id = (SELECT MAX(id) FROM upload_jobs WHERE video_id = v.id)
        WHERE v.folder_id = ?`,
    )
    .all(lib.id) as Row[];
  const byDir = new Map<string, Row[]>();
  for (const r of rows) byDir.set(path.dirname(r.file_path), [...(byDir.get(path.dirname(r.file_path)) ?? []), r]);
  let changed = 0;
  for (const [dir, list] of byDir) {
    const file = path.join(dir, 'clips.json');
    let doc: { clips?: Record<string, unknown>[] };
    try {
      doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (!doc || !Array.isArray(doc.clips)) continue;
    let dirty = false;
    for (const r of list) {
      const state = uploadState(r);
      if (!state) continue;
      const entry = doc.clips.find((c) => typeof c.file === 'string' && c.file.toLowerCase() === path.basename(r.file_path).toLowerCase());
      if (!entry) continue;
      const next = { ...state, updated: r.upload_completed_at ?? undefined };
      if (JSON.stringify(entry.upload ?? null) === JSON.stringify(next)) continue;
      entry.upload = next;
      dirty = true;
      changed++;
    }
    if (dirty) {
      try {
        writeJsonAtomic(file, doc);
      } catch (e) {
        log.warn('could not write upload state', { file, error: String(e) });
      }
    }
  }
  return changed;
}

export function startLibrarySync(db: Db, everyMs = 30_000): { stop(): void } {
  const tick = () => {
    try {
      syncUploadState(db);
    } catch (e) {
      log.warn('library sync failed', { error: String(e) });
    }
  };
  const t = setInterval(tick, everyMs);
  t.unref();
  tick();
  return { stop: () => clearInterval(t) };
}
