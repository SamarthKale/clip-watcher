import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { getSettings } from '../settings.js';
import { cancelJob, pauseQueue, resolveUnknown, resumeQueue, retryJob } from '../queue/actions.js';
import { enqueueEligible } from '../queue/enqueue.js';
import { describeJob, type JobRow } from '../queue/jobs.js';

const IdsBody = z.object({ ids: z.array(z.number().int()).min(1).max(5000) });
const ResolveBody = z.discriminatedUnion('action', [
  z.object({ action: z.literal('found'), videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/) }),
  z.object({ action: z.literal('not_uploaded') }),
]);

export function registerQueueRoutes(app: FastifyInstance): void {
  const { db } = app.deps;
  const idOf = (req: { params: unknown }) => Number((req.params as { id: string }).id);

  // Session references are never returned: they grant the ability to upload to the channel.
  app.get('/api/queue', async () => {
    const jobs = db
      .prepare(
        `SELECT j.id, j.video_id, j.status, j.visibility, j.attempt_count, j.next_retry_at, j.last_error_code, j.last_error_message,
                j.bytes_sent, j.youtube_video_id, j.upload_started_at, j.upload_completed_at,
                v.filename, v.file_size_bytes, f.display_name AS folder_name, m.title
         FROM upload_jobs j JOIN videos v ON v.id = j.video_id JOIN folders f ON f.id = v.folder_id
         LEFT JOIN video_metadata m ON m.id = j.metadata_id
         ORDER BY j.id DESC LIMIT 1000`,
      )
      .all() as (JobRow & { filename: string })[];
    return { paused: getSettings(db).queuePaused, jobs: jobs.map((j) => ({ ...j, reason: describeJob(j) })) };
  });

  app.post('/api/queue/pause', async () => {
    pauseQueue(db);
    return { paused: true };
  });
  app.post('/api/queue/resume', async () => {
    resumeQueue(db);
    return { paused: false };
  });

  // "Add to upload queue": selecting videos for upload is the explicit approval for manual-review folders.
  app.post('/api/queue/enqueue', async (req, reply) => {
    const b = IdsBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid body' });
    const approve = db.prepare("UPDATE videos SET approval_status = 'APPROVED', updated_at = datetime('now') WHERE id = ? AND metadata_status = 'READY' AND approval_status IN ('PENDING','NOT_REQUIRED')");
    db.transaction(() => { for (const id of b.data.ids) approve.run(id); })();
    return { queued: await enqueueEligible(db, { videoIds: b.data.ids }) };
  });

  const run = (fn: (id: number) => void) => async (req: { params: unknown }, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => {
    try {
      fn(idOf(req));
    } catch (e) {
      return reply.code(409).send({ error: e instanceof Error ? e.message : 'failed' });
    }
    return { ok: true };
  };
  app.post('/api/jobs/:id/cancel', run((id) => cancelJob(db, id)));
  app.post('/api/jobs/:id/retry', run((id) => retryJob(db, id)));
  app.post('/api/jobs/:id/resolve', async (req, reply) => {
    const b = ResolveBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid body' });
    try {
      resolveUnknown(db, idOf(req), b.data);
    } catch (e) {
      return reply.code(409).send({ error: e instanceof Error ? e.message : 'failed' });
    }
    return { ok: true };
  });
}
