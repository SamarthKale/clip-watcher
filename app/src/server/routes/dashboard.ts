import type { FastifyInstance } from 'fastify';
import { getSettings } from '../settings.js';

const LATEST_VIS = '(SELECT visibility FROM upload_jobs j WHERE j.video_id = v.id ORDER BY j.id DESC LIMIT 1)';

export function registerDashboardRoutes(app: FastifyInstance): void {
  const { db } = app.deps;

  // Real counts only: an empty database yields zeros and an empty activity list.
  app.get('/api/dashboard', async () => {
    const c = db
      .prepare(
        `SELECT
           COUNT(*) AS detected,
           COALESCE(SUM(v.enhance_status IN ('PENDING','RUNNING')), 0) AS enhancing,
           COALESCE(SUM(v.metadata_status = 'READY'), 0) AS metadataReady,
           COALESCE(SUM(v.approval_status = 'PENDING' AND v.metadata_status = 'READY' AND v.upload_status = 'NOT_QUEUED'), 0) AS awaitingApproval,
           COALESCE(SUM(v.upload_status IN ('QUEUED','RETRY_WAIT','BLOCKED_BY_QUOTA','BLOCKED_BY_CHANNEL_LIMIT','UPLOAD_PAUSED')), 0) AS queued,
           COALESCE(SUM(v.upload_status = 'UPLOADING'), 0) AS uploading,
           COALESCE(SUM(v.upload_status = 'UPLOAD_COMPLETE' AND v.processing_status != 'REJECTED' AND NOT (v.processing_status = 'READY' AND v.youtube_privacy = ${LATEST_VIS})), 0) AS uploadComplete,
           COALESCE(SUM(v.upload_status = 'UPLOAD_COMPLETE' AND v.processing_status = 'READY' AND v.youtube_privacy = ${LATEST_VIS}), 0) AS published,
           COALESCE(SUM(v.upload_status IN ('FAILED_PERMANENTLY','UPLOAD_OUTCOME_UNKNOWN') OR v.metadata_status = 'FAILED' OR v.discovery_status = 'INVALID' OR v.processing_status = 'REJECTED'), 0) AS failed,
           COALESCE(SUM(v.discovery_status IN ('SKIPPED','DUPLICATE') OR v.approval_status = 'REJECTED' OR v.upload_status = 'CANCELLED'), 0) AS skipped
         FROM videos v JOIN folders f ON f.id = v.folder_id WHERE f.is_enabled = 1`,
      )
      .get();
    // Why uploads are not moving, if YouTube told us to stop.
    const b = db
      .prepare(
        `SELECT COALESCE(SUM(status = 'BLOCKED_BY_CHANNEL_LIMIT'), 0) AS channelLimit,
                COALESCE(SUM(status = 'BLOCKED_BY_QUOTA'), 0) AS quota,
                MIN(CASE WHEN status = 'BLOCKED_BY_QUOTA' THEN next_retry_at END) AS resumeAfter,
                MAX(CASE WHEN status IN ('BLOCKED_BY_CHANNEL_LIMIT','BLOCKED_BY_QUOTA') THEN last_error_message END) AS message
         FROM upload_jobs`,
      )
      .get() as { channelLimit: number; quota: number; resumeAfter: string | null; message: string | null };
    return {
      counts: c,
      blocked: b,
      channel: db.prepare('SELECT id, channel_id, channel_title FROM youtube_accounts WHERE confirmed = 1 AND is_enabled = 1 ORDER BY id LIMIT 1').get() ?? null,
      paused: getSettings(db).queuePaused,
      recent: db.prepare('SELECT id, entity_type, entity_id, event_type, message, created_at FROM activity_log ORDER BY id DESC LIMIT 20').all(),
    };
  });
}
