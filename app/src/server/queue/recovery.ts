import type { Db } from '../db/db.js';
import { logActivity } from '../activity.js';
import { setJob } from './jobs.js';

/**
 * Startup recovery, driven only by persisted state. Jobs that were mid-upload when the app died, or
 * paused by a graceful shutdown, go back to QUEUED. A stored session reference is kept, so the worker
 * asks YouTube for the offset and resumes (or learns the upload had already finished) instead of
 * starting over. A job with no session reference never sent a byte, so re-queueing it cannot duplicate.
 * Jobs in UPLOAD_OUTCOME_UNKNOWN, blocked, or user-paused states are deliberately left alone.
 */
export async function recover(db: Db): Promise<void> {
  const rows = db
    .prepare("SELECT id, resumable_session_reference AS ref FROM upload_jobs WHERE status = 'UPLOADING' OR (status = 'UPLOAD_PAUSED' AND last_error_code = 'paused_shutdown')")
    .all() as { id: number; ref: string | null }[];
  for (const r of rows) {
    setJob(db, r.id, 'QUEUED', { last_error_code: null, last_error_message: null });
    logActivity(db, 'job', r.id, 'recovered', r.ref ? 'Recovered after restart; will resume the existing upload session' : 'Recovered after restart; no data had been sent');
  }
}
