import fs from 'node:fs';
import type { Db } from '../db/db.js';
import { logActivity } from '../activity.js';
import { fingerprintVideo } from '../scan/fingerprint.js';
import { resolveDuplicate } from '../scan/duplicates.js';

interface Candidate {
  id: number;
  file_path: string;
  file_size_bytes: number;
  modified_at: number;
  content_hash: string | null;
  default_visibility: string;
}

/**
 * Creates one upload job per eligible video. Eligible means: file valid, metadata READY, and either
 * explicitly APPROVED or NOT_REQUIRED in a folder that is currently auto-publish; not already queued
 * or uploaded; not a duplicate; and a confirmed channel exists. Safe to call repeatedly.
 */
export async function enqueueEligible(db: Db, opts: { videoIds?: number[] } = {}): Promise<number> {
  const account = db.prepare('SELECT id FROM youtube_accounts WHERE confirmed = 1 AND is_enabled = 1 ORDER BY id LIMIT 1').get() as { id: number } | undefined;
  if (!account) return 0;

  const filter = opts.videoIds ? `AND v.id IN (${opts.videoIds.map(() => '?').join(',') || 'NULL'})` : '';
  const candidates = db
    .prepare(
      `SELECT v.id, v.file_path, v.file_size_bytes, v.modified_at, v.content_hash, f.default_visibility
       FROM videos v JOIN folders f ON f.id = v.folder_id
       WHERE v.discovery_status = 'VALID' AND v.metadata_status = 'READY' AND v.upload_status = 'NOT_QUEUED'
         AND f.is_enabled = 1 AND v.enhance_status NOT IN ('PENDING','RUNNING')
         AND (v.approval_status = 'APPROVED' OR (v.approval_status = 'NOT_REQUIRED' AND f.auto_publish = 1))
         ${filter}
       ORDER BY v.id`,
    )
    .all(...(opts.videoIds ?? [])) as Candidate[];

  let queued = 0;
  for (const v of candidates) {
    let hash = v.content_hash;
    try {
      hash = hash ?? (await fingerprintVideo(db, v.id));
      const st = await fs.promises.stat(v.file_path);
      if (st.size !== v.file_size_bytes || Math.trunc(st.mtimeMs) !== v.modified_at) throw new Error('file changed since discovery');
    } catch (e) {
      logActivity(db, 'video', v.id, 'enqueue_skipped', `Not queued: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (resolveDuplicate(db, v.id) === 'duplicate') continue;

    const meta = db.prepare('SELECT id, content_hash FROM video_metadata WHERE video_id = ? AND is_current = 1').get(v.id) as { id: number; content_hash: string | null } | undefined;
    if (!meta || (meta.content_hash && meta.content_hash !== hash)) continue; // stale metadata

    const created = db.transaction(() => {
      // Re-check inside the transaction: the user may have rejected or changed the video while it was being hashed.
      const still = db
        .prepare(
          `SELECT 1 FROM videos v JOIN folders f ON f.id = v.folder_id
           WHERE v.id = ? AND v.upload_status = 'NOT_QUEUED' AND v.discovery_status = 'VALID' AND v.metadata_status = 'READY' AND v.enhance_status NOT IN ('PENDING','RUNNING')
             AND (v.approval_status = 'APPROVED' OR (v.approval_status = 'NOT_REQUIRED' AND f.auto_publish = 1))`,
        )
        .get(v.id);
      if (!still) return false;
      db.prepare(
        "INSERT INTO upload_jobs(video_id, youtube_account_id, metadata_id, visibility, status, file_fingerprint) VALUES(?,?,?,?, 'QUEUED', ?)",
      ).run(v.id, account.id, meta.id, v.default_visibility, `${v.file_size_bytes}:${v.modified_at}:${hash}`);
      db.prepare("UPDATE videos SET upload_status = 'QUEUED', updated_at = datetime('now') WHERE id = ?").run(v.id);
      return true;
    })();
    if (created) queued++;
  }
  return queued;
}
