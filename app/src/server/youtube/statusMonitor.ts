import type { Db } from '../db/db.js';
import { log } from '../log.js';
import type { ProcessingStatus } from '../types.js';

const DEFAULT_BASE = 'https://www.googleapis.com';
const BATCH = 50;

export interface VideoStatus {
  id: string;
  uploadStatus?: string;
  privacyStatus?: string;
  processingStatus?: string;
  failureReason?: string;
  rejectionReason?: string;
}

export interface PollDeps {
  getToken(accountId: number): Promise<string>;
  fetchVideos(ids: string[], token: string): Promise<VideoStatus[]>;
}

/** Maps what YouTube reports to LocalTube's processing state. A missing item means YouTube no longer lists the video. */
export function mapStatus(v: VideoStatus | undefined): ProcessingStatus {
  if (!v) return 'STATUS_UNKNOWN';
  if (['failed', 'rejected', 'deleted'].includes(v.uploadStatus ?? '') || ['failed', 'terminated'].includes(v.processingStatus ?? '')) return 'REJECTED';
  if (v.uploadStatus === 'processed' || v.processingStatus === 'succeeded') return 'READY';
  return 'PROCESSING';
}

export function makeFetchVideos(opts: { baseUrl?: string } = {}): PollDeps['fetchVideos'] {
  const base = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/$/, '');
  return async (ids, token) => {
    const qs = new URLSearchParams({ part: 'status,processingDetails', id: ids.join(','), maxResults: String(BATCH) });
    const res = await fetch(`${base}/youtube/v3/videos?${qs}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`videos.list failed with HTTP ${res.status}`);
    const j = (await res.json()) as {
      items?: { id: string; status?: { uploadStatus?: string; privacyStatus?: string; failureReason?: string; rejectionReason?: string }; processingDetails?: { processingStatus?: string } }[];
    };
    return (j.items ?? []).map((i) => ({
      id: i.id,
      uploadStatus: i.status?.uploadStatus,
      privacyStatus: i.status?.privacyStatus,
      failureReason: i.status?.failureReason,
      rejectionReason: i.status?.rejectionReason,
      processingStatus: i.processingDetails?.processingStatus,
    }));
  };
}

/**
 * "Published" means the transfer finished AND YouTube finished processing AND the privacy YouTube
 * reports matches what we asked for. Transfer completion alone is never enough.
 */
export function isPublished(db: Db, videoId: number): boolean {
  const r = db
    .prepare(
      `SELECT v.processing_status AS p, v.youtube_privacy AS priv, j.visibility AS vis
       FROM videos v JOIN upload_jobs j ON j.video_id = v.id
       WHERE v.id = ? AND j.status = 'UPLOAD_COMPLETE' ORDER BY j.id DESC LIMIT 1`,
    )
    .get(videoId) as { p: string; priv: string | null; vis: string } | undefined;
  return !!r && r.p === 'READY' && r.priv === r.vis;
}

interface Row {
  video_id: number;
  yid: string;
  acct: number;
}

/** One polling round. Never throws: a failed batch leaves state as it was and is retried next round. */
export async function pollProcessing(db: Db, deps: PollDeps): Promise<void> {
  const rows = db
    .prepare(
      `SELECT v.id AS video_id, j.youtube_video_id AS yid, j.youtube_account_id AS acct
       FROM upload_jobs j JOIN videos v ON v.id = j.video_id
       WHERE j.status = 'UPLOAD_COMPLETE' AND j.youtube_video_id IS NOT NULL
         AND j.id = (SELECT MAX(id) FROM upload_jobs WHERE video_id = v.id)
         AND v.processing_status IN ('NOT_CHECKED','PROCESSING','STATUS_UNKNOWN')
       ORDER BY v.id`,
    )
    .all() as Row[];
  if (!rows.length) return;

  const byAccount = new Map<number, Row[]>();
  for (const r of rows) byAccount.set(r.acct, [...(byAccount.get(r.acct) ?? []), r]);

  const update = db.prepare(
    "UPDATE videos SET processing_status = ?, youtube_privacy = COALESCE(?, youtube_privacy), processing_detail = ?, processing_checked_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
  );

  for (const [acct, list] of byAccount) {
    let token: string;
    try {
      token = await deps.getToken(acct);
    } catch (e) {
      log.warn('status check skipped: no usable token', { acct, error: e instanceof Error ? e.message : String(e) });
      continue;
    }
    for (let i = 0; i < list.length; i += BATCH) {
      const batch = list.slice(i, i + BATCH);
      let items: VideoStatus[];
      try {
        items = await deps.fetchVideos(batch.map((b) => b.yid), token);
      } catch (e) {
        log.warn('status check failed; will retry next round', { error: e instanceof Error ? e.message : String(e) });
        continue;
      }
      const byId = new Map(items.map((it) => [it.id, it]));
      db.transaction(() => {
        for (const b of batch) {
          const item = byId.get(b.yid);
          const status = mapStatus(item);
          const detail = status === 'REJECTED' ? [item?.uploadStatus, item?.failureReason, item?.rejectionReason].filter(Boolean).join(': ') : null;
          update.run(status, item?.privacyStatus ?? null, detail, b.video_id);
        }
      })();
    }
  }
}

export function startStatusMonitor(deps: PollDeps & { db: Db }, intervalMs = 60_000): { stop(): void } {
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    pollProcessing(deps.db, deps)
      .catch((e) => log.error('status monitor failed', { error: String(e) }))
      .finally(() => (running = false));
  };
  const timer = setInterval(run, intervalMs);
  run();
  return { stop: () => clearInterval(timer) };
}
