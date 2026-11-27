import fs from 'node:fs';
import type { Db } from '../db/db.js';
import { logActivity } from '../activity.js';
import { log } from '../log.js';
import { getSettings } from '../settings.js';
import { AuthRevokedError } from '../youtube/accounts.js';
import { UploadAbortedError, UploadError } from '../youtube/errors.js';
import { queryOffset, startSession, uploadFrom, type SessionMeta, type UploadOpts } from '../youtube/upload.js';
import { enqueueEligible } from './enqueue.js';
import { getJob, setJob, type JobRow } from './jobs.js';
import { resumeQueue } from './actions.js';
import { MAX_ATTEMPTS, nextQuotaResetMs, nextRetryDelayMs } from './retry.js';
import type { UploadStatus } from '../types.js';

export interface UploadWorkerDeps {
  db: Db;
  auth: { getAccessToken(accountId: number): Promise<string> };
  baseUrl?: string;
  chunkBytes?: number;
  pollMs?: number;
  /** Base backoff delay; tests lower it. */
  retryBaseMs?: number;
  now?: () => number;
  rand?: () => number;
}

export interface UploadWorker {
  stop(): Promise<void>;
  pause(): void;
  resume(): void;
}

interface MetaRow {
  title: string;
  description: string;
  hashtags_json: string;
  category_id: string | null;
}
interface VideoRow {
  id: number;
  file_path: string;
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Runs upload jobs from the persisted queue, up to `concurrency` at a time. Every transition is
 * written to SQLite before and after the network call that causes it, so a crash at any point
 * leaves a state `recover()` and the next tick can reason about.
 */
export function startUploadWorker(deps: UploadWorkerDeps, concurrency: number | (() => number)): UploadWorker {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const rand = deps.rand ?? Math.random;
  const baseMs = deps.retryBaseMs ?? 30_000;
  const upOpts: UploadOpts = { baseUrl: deps.baseUrl, chunkBytes: deps.chunkBytes };
  const inFlight = new Map<number, Promise<void>>();
  const controllers = new Map<number, AbortController>();
  let stopping = false;
  let ticking = false;

  const setJ = (id: number, status: UploadStatus, patch: Parameters<typeof setJob>[3] = {}, from?: UploadStatus[]) => setJob(db, id, status, patch, from);
  const paused = () => getSettings(db).queuePaused;

  // ---- outcomes -------------------------------------------------------------------------------
  function finish(jobId: number, videoId: string): void {
    setJ(jobId, 'UPLOAD_COMPLETE', {
      youtube_video_id: videoId,
      upload_completed_at: iso(now()),
      last_error_code: null,
      last_error_message: null,
      next_retry_at: null,
    });
    logActivity(db, 'job', jobId, 'upload_complete', `Uploaded to YouTube as ${videoId}`);
  }

  function pause(jobId: number, code: string, message: string): void {
    setJ(jobId, 'UPLOAD_PAUSED', { last_error_code: code, last_error_message: message }, ['UPLOADING', 'QUEUED']);
    logActivity(db, 'job', jobId, 'upload_paused', message);
  }

  /** Only moves a job that is still UPLOADING, so a cancel or retry made meanwhile is never overwritten. */
  function markUnknown(jobId: number, message: string): boolean {
    const changed = setJ(
      jobId,
      'UPLOAD_OUTCOME_UNKNOWN',
      { last_error_code: 'outcome_unknown', last_error_message: message, next_retry_at: iso(now() + baseMs * 2) },
      ['UPLOADING'],
    );
    if (changed) logActivity(db, 'job', jobId, 'upload_unknown', message);
    return changed;
  }

  /** Asks YouTube, through the saved session, what happened to an uncertain upload. Never starts a new upload. */
  async function reconcile(jobId: number): Promise<void> {
    const j = getJob(db, jobId);
    if (!j || j.status !== 'UPLOAD_OUTCOME_UNKNOWN' || !j.resumable_session_reference) return;
    const video = db.prepare('SELECT file_path FROM videos WHERE id = ?').get(j.video_id) as { file_path: string } | undefined;
    const later = () => setJ(jobId, 'UPLOAD_OUTCOME_UNKNOWN', { next_retry_at: iso(now() + baseMs * 2) }, ['UPLOAD_OUTCOME_UNKNOWN']);
    try {
      const size = (await fs.promises.stat(video!.file_path)).size;
      const q = await queryOffset(j.resumable_session_reference, size, upOpts);
      if (q.state === 'complete') {
        finish(jobId, q.videoId);
        logActivity(db, 'job', jobId, 'upload_reconciled', `Confirmed with YouTube: the upload completed as ${q.videoId}`);
      } else if (q.state === 'incomplete') {
        setJ(jobId, 'QUEUED', { last_error_code: null, last_error_message: null, next_retry_at: null }, ['UPLOAD_OUTCOME_UNKNOWN']);
        logActivity(db, 'job', jobId, 'upload_reconciled', 'YouTube had not received everything; resuming the same upload session');
      } else {
        later(); // session gone: only the user can decide
      }
    } catch {
      later();
    }
  }

  function blockAll(kind: 'quota' | 'channel', jobId: number, message: string): void {
    const status: UploadStatus = kind === 'quota' ? 'BLOCKED_BY_QUOTA' : 'BLOCKED_BY_CHANNEL_LIMIT';
    const reset = kind === 'quota' ? iso(nextQuotaResetMs(now())) : null;
    const patch = { next_retry_at: reset, last_error_code: kind, last_error_message: message };
    setJ(jobId, status, patch, ['UPLOADING']);
    const others = db.prepare("SELECT id FROM upload_jobs WHERE status IN ('QUEUED','RETRY_WAIT') AND id != ?").all(jobId) as { id: number }[];
    for (const o of others) setJ(o.id, status, patch, ['QUEUED', 'RETRY_WAIT']);
    logActivity(db, 'job', jobId, kind === 'quota' ? 'blocked_quota' : 'blocked_channel_limit', `${message}. ${others.length} other job(s) paused.`);
  }

  async function handleError(jobId: number, e: unknown): Promise<void> {
    if (e instanceof UploadAbortedError) {
      const cur = getJob(db, jobId);
      if (cur?.status === 'UPLOADING') {
        pause(jobId, stopping ? 'paused_shutdown' : 'paused_user', stopping ? 'Paused because the app is closing' : 'Paused by you');
      }
      return; // cancelled or otherwise changed elsewhere: leave it
    }
    if (e instanceof AuthRevokedError) {
      pause(jobId, 'auth', e.message);
      db.prepare("INSERT INTO settings(key,value) VALUES('queuePaused','true') ON CONFLICT(key) DO UPDATE SET value='true'").run();
      return;
    }
    if (e instanceof UploadError) {
      switch (e.kind) {
        case 'quota':
          return blockAll('quota', jobId, `YouTube API quota reached: ${e.message}`);
        case 'channel_limit':
          return blockAll('channel', jobId, `Channel upload limit reached: ${e.message}`);
        case 'auth':
          pause(jobId, 'auth', `Google rejected the credentials: ${e.message}`);
          db.prepare("INSERT INTO settings(key,value) VALUES('queuePaused','true') ON CONFLICT(key) DO UPDATE SET value='true'").run();
          return;
        case 'permanent':
          if (setJ(jobId, 'FAILED_PERMANENTLY', { last_error_code: 'permanent', last_error_message: e.message }, ['UPLOADING'])) {
            logActivity(db, 'job', jobId, 'upload_failed', e.message);
          }
          return;
        case 'unknown':
          if (!markUnknown(jobId, `The connection ended before YouTube confirmed the upload: ${e.message}`)) return;
          return reconcile(jobId);
        default:
          return transient(jobId, e.message, e.retryAfterMs);
      }
    }
    const err = e as NodeJS.ErrnoException;
    if (err?.code === 'ENOENT' || err?.code === 'EACCES' || err?.code === 'EBUSY') {
      return pause(jobId, 'file_missing', 'The video file is missing or unreadable (is its drive connected?)');
    }
    log.error('unexpected upload error', { jobId, error: String(e) });
    return transient(jobId, e instanceof Error ? e.message : String(e));
  }

  function transient(jobId: number, message: string, retryAfterMs?: number): void {
    const j = getJob(db, jobId)!;
    if (j.status !== 'UPLOADING') return; // cancelled, rejected or re-queued meanwhile: not ours to change
    if (j.attempt_count >= MAX_ATTEMPTS) {
      if (setJ(jobId, 'FAILED_PERMANENTLY', { last_error_code: 'gave_up', last_error_message: `Gave up after ${j.attempt_count} attempts: ${message}` }, ['UPLOADING'])) {
        logActivity(db, 'job', jobId, 'upload_failed', `Gave up after ${j.attempt_count} attempts: ${message}`);
      }
      return;
    }
    const delay = nextRetryDelayMs(j.attempt_count, rand, retryAfterMs, baseMs);
    setJ(jobId, 'RETRY_WAIT', { next_retry_at: iso(now() + delay), last_error_code: 'transient', last_error_message: message }, ['UPLOADING']);
  }

  // ---- one job --------------------------------------------------------------------------------
  async function execute(jobId: number, ac: AbortController): Promise<void> {
    const job = getJob(db, jobId) as JobRow;
    const video = db.prepare('SELECT id, file_path FROM videos WHERE id = ?').get(job.video_id) as VideoRow;

    let st: fs.Stats;
    try {
      st = await fs.promises.stat(video.file_path);
    } catch {
      return pause(jobId, 'file_missing', 'The video file is missing or unreadable (is its drive connected?)');
    }
    const [size, mtime] = (job.file_fingerprint ?? '').split(':');
    if (st.size !== Number(size) || Math.trunc(st.mtimeMs) !== Number(mtime)) {
      db.prepare("UPDATE videos SET metadata_status = 'STALE', updated_at = datetime('now') WHERE id = ?").run(video.id);
      pause(jobId, 'file_changed', 'The file changed after it was queued; its metadata is now stale');
      return;
    }

    const account = job.youtube_account_id
      ? (db.prepare('SELECT confirmed, is_enabled FROM youtube_accounts WHERE id = ?').get(job.youtube_account_id) as { confirmed: number; is_enabled: number } | undefined)
      : undefined;
    if (!account?.confirmed || !account.is_enabled) return pause(jobId, 'no_channel', 'No confirmed YouTube channel; confirm one in Accounts & Channels');

    const token = await deps.auth.getAccessToken(job.youtube_account_id!);
    // A job without a session yet takes the video's CURRENT metadata, so edits made while it waited are used.
    const currentMeta = db.prepare('SELECT id FROM video_metadata WHERE video_id = ? AND is_current = 1').get(job.video_id) as { id: number } | undefined;
    const metaId = !job.resumable_session_reference && currentMeta ? currentMeta.id : job.metadata_id;
    if (metaId !== job.metadata_id) db.prepare('UPDATE upload_jobs SET metadata_id = ? WHERE id = ?').run(metaId, jobId);
    const md = db.prepare('SELECT title, description, hashtags_json, category_id FROM video_metadata WHERE id = ?').get(metaId) as MetaRow;
    const hashtags = JSON.parse(md.hashtags_json) as string[];
    const meta: SessionMeta = {
      title: md.title,
      description: hashtags.length ? `${md.description}\n\n${hashtags.join(' ')}` : md.description,
      tags: hashtags.map((h) => h.replace(/^#/, '')),
      categoryId: md.category_id || '20',
      visibility: job.visibility,
      selfDeclaredMadeForKids: false,
    };

    let uri = job.resumable_session_reference;
    let startByte = 0;
    if (uri) {
      const q = await queryOffset(uri, st.size, upOpts);
      if (q.state === 'complete') {
        finish(jobId, q.videoId);
        return;
      }
      if (q.state === 'gone') {
        // bytes_sent only advances on a server reply, so it cannot prove nothing was sent: use the explicit flag.
        if (job.data_started || job.bytes_sent > 0) {
          markUnknown(jobId, 'The saved upload session no longer exists, so LocalTube cannot tell whether YouTube received the video');
          return;
        }
        uri = null; // nothing was ever sent: starting a fresh session cannot duplicate
      } else {
        startByte = q.nextByte;
      }
    }
    if (!uri) {
      uri = await startSession(token, meta, st.size, upOpts);
      // Persisted before any byte is sent. If the job was cancelled or re-queued meanwhile, stop here.
      if (!setJ(jobId, 'UPLOADING', { resumable_session_reference: uri, bytes_sent: 0, data_started: 0 }, ['UPLOADING'])) throw new UploadAbortedError();
    }
    // Record that bytes may now leave this machine, before the first PUT (a single-chunk upload never updates bytes_sent mid-way).
    if (!setJ(jobId, 'UPLOADING', { data_started: 1 }, ['UPLOADING'])) throw new UploadAbortedError();

    const result = await uploadFrom(
      uri,
      video.file_path,
      startByte,
      (sent) => {
        db.prepare("UPDATE upload_jobs SET bytes_sent = ?, updated_at = datetime('now') WHERE id = ?").run(sent, jobId);
        if (stopping || paused() || getJob(db, jobId)?.status !== 'UPLOADING') ac.abort();
      },
      ac.signal,
      upOpts,
    );
    finish(jobId, result.videoId);
  }

  function launch(jobId: number): void {
    const ac = new AbortController();
    controllers.set(jobId, ac);
    const p = execute(jobId, ac)
      .catch((e) => handleError(jobId, e))
      .catch((e) => log.error('upload job handler failed', { jobId, error: String(e) }))
      .finally(() => {
        controllers.delete(jobId);
        inFlight.delete(jobId);
      });
    inFlight.set(jobId, p);
  }

  // ---- scheduling -----------------------------------------------------------------------------
  function promoteDue(): void {
    const t = iso(now());
    const due = db
      .prepare("SELECT id FROM upload_jobs WHERE status IN ('RETRY_WAIT','BLOCKED_BY_QUOTA') AND next_retry_at IS NOT NULL AND next_retry_at <= ?")
      .all(t) as { id: number }[];
    for (const d of due) setJ(d.id, 'QUEUED', { next_retry_at: null, last_error_code: null }, ['RETRY_WAIT', 'BLOCKED_BY_QUOTA']);
  }

  function claim(): number | null {
    const busy = [...inFlight.keys()]; // a job still winding down from an earlier attempt must not be claimed again
    const row = db
      .prepare(`SELECT id FROM upload_jobs WHERE status = 'QUEUED' ${busy.length ? `AND id NOT IN (${busy.map(() => '?').join(',')})` : ''} ORDER BY id LIMIT 1`)
      .get(...busy) as { id: number } | undefined;
    if (!row) return null;
    const ok = db.transaction(() => {
      const r = db
        .prepare("UPDATE upload_jobs SET status='UPLOADING', attempt_count = attempt_count + 1, upload_started_at = COALESCE(upload_started_at, ?), next_retry_at = NULL, updated_at = datetime('now') WHERE id = ? AND status = 'QUEUED'")
        .run(iso(now()), row.id);
      if (r.changes) db.prepare("UPDATE videos SET upload_status = 'UPLOADING', updated_at = datetime('now') WHERE id = (SELECT video_id FROM upload_jobs WHERE id = ?)").run(row.id);
      return r.changes > 0;
    })();
    return ok ? row.id : null;
  }

  async function tick(): Promise<void> {
    if (stopping || ticking) return;
    ticking = true;
    try {
      promoteDue();
      if (paused()) return;
      await enqueueEligible(db).catch((e) => log.error('enqueue failed', { error: String(e) }));
      const unknown = db
        .prepare("SELECT id FROM upload_jobs WHERE status = 'UPLOAD_OUTCOME_UNKNOWN' AND resumable_session_reference IS NOT NULL AND (next_retry_at IS NULL OR next_retry_at <= ?)")
        .all(iso(now())) as { id: number }[];
      for (const u of unknown) await reconcile(u.id);
      const max = typeof concurrency === 'function' ? concurrency() : concurrency;
      while (!stopping && inFlight.size < max) {
        const id = claim();
        if (id === null) break;
        launch(id);
      }
    } finally {
      ticking = false;
    }
  }

  const timer = setInterval(() => void tick().catch((e) => log.error('upload tick failed', { error: String(e) })), deps.pollMs ?? 2000);
  void tick().catch(() => undefined);

  return {
    async stop() {
      stopping = true;
      clearInterval(timer);
      for (const ac of controllers.values()) ac.abort();
      await Promise.allSettled([...inFlight.values()]);
    },
    pause() {
      db.prepare("INSERT INTO settings(key,value) VALUES('queuePaused','true') ON CONFLICT(key) DO UPDATE SET value='true'").run();
    },
    resume() {
      resumeQueue(db);
    },
  };
}
