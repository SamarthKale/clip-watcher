import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { extractFrames } from '../media/frames.js';
import { allowRepublish } from '../scan/duplicates.js';
import { scanFolder } from '../scan/scanner.js';
import { discoverManifests } from '../manifest/manifest.js';
import { getSettings } from '../settings.js';

const LATEST_JOB = '(SELECT id FROM upload_jobs j WHERE j.video_id = v.id ORDER BY j.id DESC LIMIT 1)';

export function registerVideoRoutes(app: FastifyInstance): void {
  const { db } = app.deps;
  const idOf = (req: { params: unknown }) => Number((req.params as { id: string }).id);

  app.post('/api/folders/:id/scan', async (req, reply) => {
    const id = idOf(req);
    const folder = db.prepare('SELECT id FROM folders WHERE id = ? AND is_enabled = 1').get(id);
    if (!folder) return reply.code(404).send({ error: 'folder not found' });
    const scan = await scanFolder(db, id, { stableMs: getSettings(db).stableMs });
    const s = getSettings(db);
    const enhance = s.enhanceImports && s.aiConsent && !!(await app.deps.getProvider());
    const metadata = await discoverManifests(db, id, { enhance }); // clips.json next to the videos fills in titles and descriptions
    return { ...scan, metadata };
  });

  app.get('/api/videos', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const where: string[] = ['f.is_enabled = 1'];
    const params: Record<string, unknown> = {};
    const eq = (key: string, col: string) => {
      if (q[key]) {
        where.push(`${col} = @${key}`);
        params[key] = q[key];
      }
    };
    if (q.folderId) {
      where.push('v.folder_id = @folderId');
      params.folderId = Number(q.folderId);
    }
    eq('metadataStatus', 'v.metadata_status');
    eq('approvalStatus', 'v.approval_status');
    eq('uploadStatus', 'v.upload_status');
    eq('discoveryStatus', 'v.discovery_status');
    if (q.aiProfileId) {
      where.push('m.ai_profile_id = @aiProfileId');
      params.aiProfileId = Number(q.aiProfileId);
    }
    if (q.errorsOnly === '1') {
      where.push(`(v.metadata_status = 'FAILED' OR v.discovery_status IN ('INVALID','UNAVAILABLE') OR v.upload_status IN ('FAILED_PERMANENTLY','UPLOAD_OUTCOME_UNKNOWN','UPLOAD_PAUSED') OR v.processing_status = 'REJECTED')`);
    }
    const videos = db
      .prepare(
        `SELECT v.id, v.folder_id, f.display_name AS folder_name, v.filename, v.file_path, v.duration_seconds, v.file_size_bytes, v.width, v.height,
                v.shorts_warning, v.discovery_status, v.metadata_status, v.approval_status, v.upload_status, v.processing_status,
                v.youtube_privacy, v.created_at,
                v.enhance_status, m.provider AS metadata_source,
                m.title, m.description, m.hashtags_json, m.confidence, m.needs_review, m.ai_profile_id, p.name AS ai_profile,
                j.youtube_video_id, j.visibility AS requested_visibility,
                CASE WHEN j.youtube_video_id IS NULL THEN NULL ELSE 'https://youtu.be/' || j.youtube_video_id END AS youtube_url,
                COALESCE(j.last_error_message,
                  CASE WHEN v.metadata_status = 'FAILED' THEN (SELECT message FROM activity_log a WHERE a.entity_type = 'video' AND a.entity_id = v.id AND a.event_type = 'ai_failed' ORDER BY a.id DESC LIMIT 1) END
                ) AS last_error
         FROM videos v
         JOIN folders f ON f.id = v.folder_id
         LEFT JOIN video_metadata m ON m.video_id = v.id AND m.is_current = 1
         LEFT JOIN ai_profiles p ON p.id = m.ai_profile_id
         LEFT JOIN upload_jobs j ON j.id = ${LATEST_JOB}
         WHERE ${where.join(' AND ')}
         ORDER BY v.id DESC LIMIT 5000`,
      )
      .all(params);
    return { videos };
  });

  // Thumbnail for the library: one frame from the middle, cached in the app's scratch directory.
  app.get('/api/videos/:id/thumbnail', async (req, reply) => {
    const v = db.prepare('SELECT id, file_path, modified_at, duration_seconds FROM videos WHERE id = ?').get(idOf(req)) as
      | { id: number; file_path: string; modified_at: number | null; duration_seconds: number | null }
      | undefined;
    if (!v) return reply.code(404).send({ error: 'not found' });
    const dir = path.join(app.deps.tempDir(), 'thumbs', `${v.id}-${v.modified_at ?? 0}`);
    const file = path.join(dir, 'frame-00.jpg');
    try {
      if (!fs.existsSync(file)) await extractFrames(v.file_path, v.duration_seconds ?? 1, 1, dir);
      return reply.header('content-type', 'image/jpeg').header('cache-control', 'private, max-age=3600').send(fs.readFileSync(file));
    } catch {
      return reply.code(404).send({ error: 'thumbnail unavailable' });
    }
  });

  app.post('/api/videos/:id/allow-republish', async (req, reply) => {
    const id = idOf(req);
    if (!db.prepare('SELECT 1 FROM videos WHERE id = ?').get(id)) return reply.code(404).send({ error: 'not found' });
    allowRepublish(db, id);
    return { ok: true };
  });
}
