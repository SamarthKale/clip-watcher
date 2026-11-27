import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { logActivity } from '../activity.js';
import { generateMetadata } from '../ai/generate.js';
import { validateMetadata } from '../ai/metadataSchema.js';
import { rejectVideos } from '../queue/actions.js';
import { enhanceMetadata } from '../ai/enhance.js';
import { getSettings } from '../settings.js';

const EditBody = z.object({ title: z.string(), description: z.string(), hashtags: z.array(z.string()) });
const IdsBody = z.object({ ids: z.array(z.number().int()).min(1).max(5000) });
const RegenBody = z.object({ only: z.enum(['title', 'description', 'hashtags']).optional() });

interface CurrentRow {
  id: number;
  ai_profile_id: number | null;
  prompt_version: number | null;
  provider: string | null;
  model: string | null;
  category_id: string | null;
  language: string | null;
  content_hash: string | null;
}

export function registerMetadataRoutes(app: FastifyInstance): void {
  const { db } = app.deps;
  const idOf = (req: { params: unknown }) => Number((req.params as { id: string }).id);

  // User edit: becomes the current metadata after the same validation as AI output.
  app.put('/api/videos/:id/metadata', async (req, reply) => {
    const id = idOf(req);
    const body = EditBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid metadata' });
    const info = db
      .prepare('SELECT v.content_hash, f.ai_profile_id, f.default_category_id, f.auto_publish FROM videos v JOIN folders f ON f.id = v.folder_id WHERE v.id = ?')
      .get(id) as { content_hash: string | null; ai_profile_id: number | null; default_category_id: string; auto_publish: number } | undefined;
    if (!info) return reply.code(404).send({ error: 'video not found' });
    // Writing metadata by hand works even if the AI never ran (or is switched off).
    const cur: CurrentRow =
      (db.prepare('SELECT * FROM video_metadata WHERE video_id = ? AND is_current = 1').get(id) as CurrentRow | undefined) ?? {
        id: 0, ai_profile_id: info.ai_profile_id, prompt_version: null, provider: null, model: null,
        category_id: info.default_category_id, language: null, content_hash: info.content_hash,
      };
    const v = validateMetadata({ ...body.data, confidence: 'high', needsReview: false });
    if (!v.ok) return reply.code(400).send({ error: 'invalid metadata', details: v.errors });
    const hadMetadata = cur.id !== 0;
    db.transaction(() => {
      db.prepare('UPDATE video_metadata SET is_current = 0 WHERE video_id = ?').run(id);
      db.prepare(
        `INSERT INTO video_metadata(video_id, ai_profile_id, prompt_version, provider, model, title, description, hashtags_json, category_id, language, confidence, needs_review, is_current, content_hash)
         VALUES(?,?,?,?,?,?,?,?,?,?, 'high', 0, 1, ?)`,
      ).run(id, cur.ai_profile_id, cur.prompt_version, 'user-edit', cur.model, v.value.title, v.value.description, JSON.stringify(v.value.hashtags), cur.category_id, cur.language, cur.content_hash);
      db.prepare("UPDATE videos SET metadata_status='READY', updated_at=datetime('now') WHERE id = ?").run(id);
      if (!hadMetadata) {
        db.prepare("UPDATE videos SET approval_status = ? WHERE id = ?").run(info.auto_publish ? 'NOT_REQUIRED' : 'PENDING', id);
      }
    })();
    logActivity(db, 'video', id, 'metadata_edited', 'User edited metadata');
    // A queued job picks this edit up when its upload session starts. Once a session exists, YouTube already has the old text.
    const job = db.prepare('SELECT status, resumable_session_reference AS ref FROM upload_jobs WHERE video_id = ? ORDER BY id DESC LIMIT 1').get(id) as { status: string; ref: string | null } | undefined;
    const warning = job && job.status !== 'CANCELLED' && (job.ref || job.status === 'UPLOAD_COMPLETE')
      ? 'An upload has already started (or finished) for this video, so YouTube keeps the previous title and description. Change it in YouTube Studio.'
      : undefined;
    return { ...(db.prepare('SELECT * FROM video_metadata WHERE video_id = ? AND is_current = 1').get(id) as object), ...(warning ? { warning } : {}) };
  });

  // Regenerate one field (or everything) for a single video, waiting for the result.
  app.post('/api/videos/:id/regenerate', async (req, reply) => {
    const id = idOf(req);
    const body = RegenBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'invalid body' });
    const provider = await app.deps.getProvider();
    if (!provider) return reply.code(409).send({ error: 'No Gemini API key is configured' });
    const r = await generateMetadata({ db, provider, tempDir: app.deps.tempDir() }, id, { only: body.data.only, useCache: false });
    if (r.status === 'skipped') return reply.code(409).send({ error: r.error });
    if (r.status === 'failed') return reply.code(502).send({ error: r.error });
    return db.prepare('SELECT * FROM video_metadata WHERE video_id = ? AND is_current = 1').get(id);
  });

  // Bulk regenerate: mark STALE so the AI worker redoes them in the background.
  app.post('/api/videos/regenerate', async (req, reply) => {
    const b = IdsBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid body' });
    const stmt = db.prepare("UPDATE videos SET metadata_status='STALE', updated_at=datetime('now') WHERE id = ? AND discovery_status='VALID' AND metadata_status IN ('READY','FAILED','NOT_STARTED','STALE')");
    let n = 0;
    db.transaction(() => { for (const id of b.data.ids) n += stmt.run(id).changes; })();
    return { updated: n };
  });

  const geminiProvider = async () => (getSettings(db).aiConsent ? await app.deps.getProvider() : null);
  const NOT_READY = 'Gemini is not set up: add your API key and tick the consent box in Settings.';

  // Queue many videos for Gemini to improve in the background. Hand-written, uploaded and empty ones are skipped.
  app.post('/api/videos/enhance', async (req, reply) => {
    const b = IdsBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid body' });
    if (!(await geminiProvider())) return reply.code(409).send({ error: NOT_READY });
    const stmt = db.prepare(
      `UPDATE videos SET enhance_status = 'PENDING', updated_at = datetime('now')
       WHERE id = ? AND metadata_status = 'READY' AND enhance_status NOT IN ('PENDING','RUNNING')
         AND upload_status NOT IN ('UPLOADING','UPLOAD_COMPLETE','UPLOAD_OUTCOME_UNKNOWN')
         AND EXISTS (SELECT 1 FROM video_metadata m WHERE m.video_id = videos.id AND m.is_current = 1 AND COALESCE(m.provider,'') != 'user-edit')`,
    );
    let n = 0;
    db.transaction(() => { for (const id of b.data.ids) n += stmt.run(id).changes; })();
    return { queued: n };
  });

  // Improve one video right now, even if the user wrote its text (an explicit request).
  app.post('/api/videos/:id/enhance', async (req, reply) => {
    const id = idOf(req);
    if (!db.prepare('SELECT 1 FROM videos WHERE id = ?').get(id)) return reply.code(404).send({ error: 'not found' });
    const provider = await geminiProvider();
    if (!provider) return reply.code(409).send({ error: NOT_READY });
    const r = await enhanceMetadata({ db, provider }, id, { explicit: true });
    if (r.status === 'skipped') return reply.code(409).send({ error: r.error });
    if (r.status === 'failed') return reply.code(502).send({ error: r.error });
    return db.prepare('SELECT * FROM video_metadata WHERE video_id = ? AND is_current = 1').get(id);
  });

  // Put the original clip-JSON text back, and stop it being improved again.
  app.post('/api/videos/:id/restore-original', async (req, reply) => {
    const id = idOf(req);
    const v = db.prepare('SELECT upload_status FROM videos WHERE id = ?').get(id) as { upload_status: string } | undefined;
    if (!v) return reply.code(404).send({ error: 'not found' });
    if (['UPLOADING', 'UPLOAD_COMPLETE', 'UPLOAD_OUTCOME_UNKNOWN'].includes(v.upload_status)) return reply.code(409).send({ error: 'This video is already uploaded or uploading' });
    const original = db.prepare("SELECT id FROM video_metadata WHERE video_id = ? AND provider = 'manifest' ORDER BY id DESC LIMIT 1").get(id) as { id: number } | undefined;
    if (!original) return reply.code(404).send({ error: 'There is no original JSON text for this video' });
    db.transaction(() => {
      db.prepare('UPDATE video_metadata SET is_current = 0 WHERE video_id = ?').run(id);
      db.prepare('UPDATE video_metadata SET is_current = 1 WHERE id = ?').run(original.id);
      db.prepare("UPDATE videos SET enhance_status = 'RESTORED', metadata_status = 'READY', updated_at = datetime('now') WHERE id = ?").run(id);
    })();
    logActivity(db, 'video', id, 'restored_original', 'Restored the original text from the clip JSON');
    return db.prepare('SELECT * FROM video_metadata WHERE video_id = ? AND is_current = 1').get(id);
  });

  app.post('/api/videos/approve', async (req, reply) => {
    const b = IdsBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid body' });
    const stmt = db.prepare("UPDATE videos SET approval_status='APPROVED', updated_at=datetime('now') WHERE id = ? AND metadata_status='READY'");
    let n = 0;
    db.transaction(() => { for (const id of b.data.ids) n += stmt.run(id).changes; })();
    return { updated: n };
  });

  app.post('/api/videos/reject', async (req, reply) => {
    const b = IdsBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid body' });
    return { updated: rejectVideos(db, b.data.ids) };
  });
}
