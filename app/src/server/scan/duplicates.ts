import type { Db } from '../db/db.js';

/**
 * Decides whether a hashed video duplicates another. The earlier-created video wins,
 * unless the other copy already has a (non-cancelled) upload job. A video that already has
 * its own upload job, or was explicitly allowed to be republished, is never flagged.
 */
export function resolveDuplicate(db: Db, videoId: number): 'unique' | 'duplicate' {
  const v = db.prepare('SELECT id, content_hash, allow_republish, discovery_status FROM videos WHERE id = ?').get(videoId) as
    | { id: number; content_hash: string | null; allow_republish: number; discovery_status: string }
    | undefined;
  if (!v) throw new Error(`video ${videoId} not found`);
  if (!v.content_hash) throw new Error(`video ${videoId} has no content hash yet`);
  if (v.allow_republish) return 'unique';

  const hasOwnJob = db.prepare("SELECT 1 FROM upload_jobs WHERE video_id = ? AND status != 'CANCELLED'").get(videoId);
  if (hasOwnJob) return 'unique';

  const twin = db
    .prepare(
      `SELECT 1 FROM videos o WHERE o.content_hash = @h AND o.id != @id AND (
         o.id < @id OR EXISTS (SELECT 1 FROM upload_jobs j WHERE j.video_id = o.id AND j.status != 'CANCELLED'))`,
    )
    .get({ h: v.content_hash, id: videoId });
  if (!twin) return 'unique';

  if (v.discovery_status === 'VALID') {
    db.prepare("UPDATE videos SET discovery_status = 'DUPLICATE', updated_at = datetime('now') WHERE id = ?").run(videoId);
  }
  return 'duplicate';
}

/** Explicit user action: publish this file even though an identical one exists. */
export function allowRepublish(db: Db, videoId: number): void {
  db.transaction(() => {
    db.prepare(
      "UPDATE videos SET allow_republish = 1, discovery_status = CASE WHEN discovery_status = 'DUPLICATE' THEN 'VALID' ELSE discovery_status END, updated_at = datetime('now') WHERE id = ?",
    ).run(videoId);
    db.prepare("INSERT INTO activity_log(entity_type, entity_id, event_type, message) VALUES('video', ?, 'republish_allowed', 'User allowed republishing a duplicate file')").run(videoId);
  })();
}
