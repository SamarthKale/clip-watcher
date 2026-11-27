import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';

/** Where the Python pipeline's local API listens (Clip Watcher `python -m clipwatcher ui`). */
export function pipelineUrl(): string {
  return (process.env.PIPELINE_URL ?? 'http://127.0.0.1:8765').replace(/\/+$/, '');
}

/**
 * The UI talks only to this server. Pipeline calls are forwarded here, behind the same token and
 * cookie lock as every other /api route, so the pipeline API is never reached from a web page.
 * Only the endpoints Clip Watcher defines are forwarded (a fixed allow-list, no free-form paths).
 */
const ALLOWED_GET = /^(state|chat|shorts|logs|usage|vod|watch|storage|paths|health|setup)$/;
const ALLOWED_POST = /^(start|stop|skip|retry|open|vod\/add|vod\/retry|watch\/add|watch\/remove|watch\/check|storage\/plan|storage\/run)$/;

/** Shared secret the desktop app gives both servers, so no other program can use the pipeline API. */
const authHeaders = (): Record<string, string> => (process.env.PIPELINE_TOKEN ? { 'x-clipper-token': process.env.PIPELINE_TOKEN } : {});

export function registerPipelineRoutes(app: FastifyInstance, base: () => string = pipelineUrl): void {
  const offline = (reply: { code(n: number): { send(b: unknown): unknown } }) =>
    reply.code(502).send({ error: 'pipeline offline', detail: 'The clipping pipeline is not running. Start it from Home.' });

  app.get<{ Params: { name: string }; Querystring: Record<string, string> }>('/api/pipeline/:name', async (req, reply) => {
    if (!ALLOWED_GET.test(req.params.name)) return reply.code(404).send({ error: 'not found' });
    const qs = new URLSearchParams(req.query as Record<string, string>).toString();
    try {
      const r = await fetch(`${base()}/api/${req.params.name}${qs ? `?${qs}` : ''}`, { headers: authHeaders(), signal: AbortSignal.timeout(15_000) });
      return reply.code(r.status).type('application/json').send(await r.text());
    } catch {
      return offline(reply);
    }
  });

  app.post<{ Params: { '*': string } }>('/api/pipeline/*', async (req, reply) => {
    const name = req.params['*'];
    if (!ALLOWED_POST.test(name)) return reply.code(404).send({ error: 'not found' });
    try {
      const r = await fetch(`${base()}/api/${name}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify(req.body ?? {}),
        signal: AbortSignal.timeout(60_000),
      });
      return reply.code(r.status).type('application/json').send(await r.text());
    } catch {
      return offline(reply);
    }
  });

  // Finished Shorts and thumbnails from Clip Watcher's player (ranged, so seeking works).
  app.get<{ Params: { id: string; name: string } }>('/api/pipeline-media/:id/:name', async (req, reply) => {
    if (!/^[A-Za-z0-9_.-]+$/.test(req.params.id) || !/^(short\.mp4|thumbnail\.jpg|cover\.jpg)$/.test(req.params.name)) {
      return reply.code(404).send({ error: 'not found' });
    }
    try {
      const headers: Record<string, string> = authHeaders();
      if (typeof req.headers.range === 'string') headers.range = req.headers.range;
      const r = await fetch(`${base()}/media/${req.params.id}/${req.params.name}`, { headers });
      reply.code(r.status);
      for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
        const v = r.headers.get(h);
        if (v) reply.header(h, v);
      }
      return reply.send(r.body ? Readable.fromWeb(r.body as never) : '');
    } catch {
      return offline(reply);
    }
  });
}
