import type { Db } from '../db/db.js';
import { logActivity } from '../activity.js';
import { setSettings } from '../settings.js';
import { getJob, setJob } from './jobs.js';
import type { UploadStatus } from '../types.js';

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const CANCELLABLE: UploadStatus[] = ['QUEUED', 'UPLOADING', 'RETRY_WAIT', 'BLOCKED_BY_QUOTA', 'BLOCKED_BY_CHANNEL_LIMIT', 'UPLOAD_PAUSED', 'UPLOAD_OUTCOME_UNKNOWN'];
const RETRYABLE: UploadStatus[] = ['FAILED_PERMANENTLY', 'CANCELLED', 'RETRY_WAIT', 'BLOCKED_BY_QUOTA', 'BLOCKED_BY_CHANNEL_LIMIT', 'UPLOAD_PAUSED'];

export function pauseQueue(db: Db): void {
  setSettings(db, { queuePaused: true });
}

/** Un-pauses the queue and re-queues jobs that were paused by the user or by an auth problem. */
export function resumeQueue(db: Db): void {
  setSettings(db, { queuePaused: false });
  const rows = db
    .prepare("SELECT id FROM upload_jobs WHERE status = 'UPLOAD_PAUSED' AND last_error_code IN ('paused_user','auth','no_channel')")
    .all() as { id: number }[];
  for (const r of rows) setJob(db, r.id, 'QUEUED', { last_error_code: null, last_error_message: null }, ['UPLOAD_PAUSED']);
}

export function cancelJob(db: Db, jobId: number): void {
  const j = getJob(db, jobId);
  if (!j) throw new Error('job not found');
  if (!setJob(db, jobId, 'CANCELLED', { next_retry_at: null }, CANCELLABLE)) throw new Error(`a ${j.status} job cannot be cancelled`);
  logActivity(db, 'job', jobId, 'cancelled', 'User cancelled the upload');
}

/** Manual retry: resets the attempt count. A job whose file changed goes back through metadata generation. */
export function retryJob(db: Db, jobId: number): void {
  const j = getJob(db, jobId);
  if (!j) throw new Error('job not found');
  if (!RETRYABLE.includes(j.status)) throw new Error(`a ${j.status} job cannot be retried`);
  if (j.last_error_code === 'file_changed') {
    db.transaction(() => {
      setJob(db, jobId, 'CANCELLED', { last_error_message: 'File changed after queueing; re-queued with fresh metadata' }, RETRYABLE);
      db.prepare("UPDATE videos SET upload_status = 'NOT_QUEUED', content_hash = NULL, updated_at = datetime('now') WHERE id = ?").run(j.video_id);
    })();
    logActivity(db, 'job', jobId, 'retry_after_change', 'File changed; the video will be queued again once its metadata is regenerated');
    return;
  }
  try {
    setJob(db, jobId, 'QUEUED', { attempt_count: 0, next_retry_at: null, last_error_code: null, last_error_message: null }, RETRYABLE);
  } catch (e) {
    if (e instanceof Error && /UNIQUE/.test(e.message)) throw new Error('another upload is already active for this video');
    throw e;
  }
  logActivity(db, 'job', jobId, 'retry', 'User retried the upload');
}

export type ResolveInput = { action: 'found'; videoId: string } | { action: 'not_uploaded' };

/**
 * The user's decision for an upload whose outcome LocalTube could not determine. Always audited.
 * "not_uploaded" re-queues with a brand new session: the user accepts the duplicate risk.
 */
export function resolveUnknown(db: Db, jobId: number, input: ResolveInput): void {
  const j = getJob(db, jobId);
  if (!j || j.status !== 'UPLOAD_OUTCOME_UNKNOWN') throw new Error('only a job with an unknown outcome can be resolved');
  if (input.action === 'found') {
    if (!YOUTUBE_ID.test(input.videoId)) throw new Error('that is not a valid YouTube video id');
    setJob(db, jobId, 'UPLOAD_COMPLETE', { youtube_video_id: input.videoId, upload_completed_at: new Date().toISOString(), last_error_code: null, last_error_message: null, next_retry_at: null });
    logActivity(db, 'job', jobId, 'unknown_resolved', `User confirmed the video exists on YouTube (${input.videoId})`, { action: 'found', videoId: input.videoId });
  } else {
    setJob(db, jobId, 'QUEUED', { resumable_session_reference: null, bytes_sent: 0, data_started: 0, attempt_count: 0, last_error_code: null, last_error_message: null, next_retry_at: null });
    logActivity(db, 'job', jobId, 'unknown_resolved', 'User confirmed the video is NOT on YouTube; the upload was queued again', { action: 'not_uploaded' });
  }
}

const STOPPABLE_ON_REJECT: UploadStatus[] = ['QUEUED', 'UPLOADING', 'RETRY_WAIT', 'BLOCKED_BY_QUOTA', 'BLOCKED_BY_CHANNEL_LIMIT', 'UPLOAD_PAUSED'];

/**
 * Rejecting a video also cancels any job that has not finished, including one mid-upload (the worker
 * notices at its next chunk). A job in UPLOAD_OUTCOME_UNKNOWN is left for the user to resolve.
 */
export function rejectVideos(db: Db, ids: number[]): number {
  let n = 0;
  db.transaction(() => {
    const upd = db.prepare("UPDATE videos SET approval_status = 'REJECTED', updated_at = datetime('now') WHERE id = ?");
    for (const id of ids) {
      n += upd.run(id).changes;
      const jobs = db.prepare('SELECT id FROM upload_jobs WHERE video_id = ?').all(id) as { id: number }[];
      for (const j of jobs) {
        if (setJob(db, j.id, 'CANCELLED', { next_retry_at: null, last_error_message: 'Video was rejected' }, STOPPABLE_ON_REJECT)) {
          logActivity(db, 'job', j.id, 'cancelled', 'Cancelled because the video was rejected');
        }
      }
    }
  })();
  return n;
}
