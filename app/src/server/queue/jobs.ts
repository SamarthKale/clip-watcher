import type { Db } from '../db/db.js';
import type { UploadStatus, Visibility } from '../types.js';

export interface JobRow {
  id: number;
  video_id: number;
  youtube_account_id: number | null;
  metadata_id: number | null;
  visibility: Visibility;
  status: UploadStatus;
  attempt_count: number;
  next_retry_at: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  resumable_session_reference: string | null;
  bytes_sent: number;
  /** 1 once a request carrying video bytes may have left this machine (persisted before the first PUT). */
  data_started: number;
  file_fingerprint: string | null;
  youtube_video_id: string | null;
  upload_started_at: string | null;
  upload_completed_at: string | null;
}

export type JobPatch = Partial<
  Pick<
    JobRow,
    | 'attempt_count' | 'next_retry_at' | 'last_error_code' | 'last_error_message' | 'resumable_session_reference'
    | 'bytes_sent' | 'data_started' | 'youtube_video_id' | 'upload_started_at' | 'upload_completed_at' | 'file_fingerprint'
  >
>;

const PATCH_KEYS: (keyof JobPatch)[] = [
  'attempt_count', 'next_retry_at', 'last_error_code', 'last_error_message', 'resumable_session_reference',
  'bytes_sent', 'data_started', 'youtube_video_id', 'upload_started_at', 'upload_completed_at', 'file_fingerprint',
];

export function getJob(db: Db, id: number): JobRow | undefined {
  return db.prepare('SELECT * FROM upload_jobs WHERE id = ?').get(id) as JobRow | undefined;
}

/**
 * The only way a job's status changes. Updates the job and the video's upload_status in one
 * transaction. With `from`, the change applies only if the job is currently in one of those states
 * (so a concurrent cancel is never overwritten). Returns whether anything changed.
 */
export function setJob(db: Db, jobId: number, status: UploadStatus, patch: JobPatch = {}, from?: UploadStatus[]): boolean {
  const keys = PATCH_KEYS.filter((k) => k in patch);
  const sets = ['status = @status', "updated_at = datetime('now')", ...keys.map((k) => `${k} = @${k}`)];
  let where = 'id = @id';
  const params: Record<string, unknown> = { status, id: jobId, ...Object.fromEntries(keys.map((k) => [k, patch[k] ?? null])) };
  if (from) {
    where += ` AND status IN (${from.map((_, i) => `@f${i}`).join(',')})`;
    from.forEach((f, i) => (params[`f${i}`] = f));
  }
  return db.transaction(() => {
    const r = db.prepare(`UPDATE upload_jobs SET ${sets.join(', ')} WHERE ${where}`).run(params);
    if (r.changes > 0) {
      db.prepare("UPDATE videos SET upload_status = ?, updated_at = datetime('now') WHERE id = (SELECT video_id FROM upload_jobs WHERE id = ?)").run(status, jobId);
    }
    return r.changes > 0;
  })();
}

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'later');

/** Why a job is where it is, in plain words (QUE-11). */
export function describeJob(j: Pick<JobRow, 'status' | 'last_error_code' | 'last_error_message' | 'next_retry_at' | 'attempt_count'>): string {
  const err = j.last_error_message ? ` (${j.last_error_message})` : '';
  switch (j.status) {
    case 'QUEUED': return 'Waiting for its turn in the queue (one upload at a time)';
    case 'UPLOADING': return 'Uploading to YouTube';
    case 'RETRY_WAIT': return `Temporary problem; retrying at ${fmt(j.next_retry_at)}, attempt ${j.attempt_count} of 6${err}`;
    case 'BLOCKED_BY_QUOTA': return `YouTube API quota reached. Resumes automatically after about ${fmt(j.next_retry_at)}, or press Retry${err}`;
    case 'BLOCKED_BY_CHANNEL_LIMIT': return `The channel's upload limit was reached. Press Retry once YouTube allows more uploads${err}`;
    case 'UPLOAD_PAUSED':
      if (j.last_error_code === 'paused_user') return 'Paused by you. Press Resume to continue';
      if (j.last_error_code === 'paused_shutdown') return 'Paused when the app closed; resumes on next start';
      if (j.last_error_code === 'auth') return 'Google access needs to be reconnected in Accounts & Channels, then press Resume';
      if (j.last_error_code === 'file_changed') return 'The video file changed after it was queued. Regenerate its metadata, then press Retry to queue it again';
      if (j.last_error_code === 'file_missing') return 'The video file is missing or its drive is disconnected. Reconnect it, then press Retry';
      return `Paused${err}`;
    case 'UPLOAD_OUTCOME_UNKNOWN': return `Needs your attention: Spikecut cannot tell whether YouTube received this video. Check your channel in YouTube Studio, then choose "I found it" or "Not uploaded"${err}`;
    case 'UPLOAD_COMPLETE': return 'Uploaded to YouTube';
    case 'FAILED_PERMANENTLY': return `Failed${err}`;
    case 'CANCELLED': return 'Cancelled';
    default: return j.status;
  }
}
