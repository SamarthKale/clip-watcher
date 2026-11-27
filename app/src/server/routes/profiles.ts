import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { createProfile, deleteProfile, duplicateProfile, getProfile, listProfiles, updateProfile } from '../ai/profileRepo.js';

const Body = z
  .object({
    name: z.string().min(1).max(100),
    model: z.string().max(100),
    title_prompt: z.string().max(4000),
    description_prompt: z.string().max(4000),
    hashtag_prompt: z.string().max(2000),
    fixed_hashtags: z.string().max(1000).refine((s) => {
      try {
        return Array.isArray(JSON.parse(s));
      } catch {
        return false;
      }
    }, 'fixed_hashtags must be a JSON array'),
    language: z.string().max(20),
    tone: z.string().max(500),
    target_audience: z.string().max(500),
  })
  .partial()
  .strict();

export function registerProfileRoutes(app: FastifyInstance): void {
  const { db } = app.deps;
  const idOf = (req: { params: unknown }) => Number((req.params as { id: string }).id);

  app.get('/api/profiles', async () => listProfiles(db));

  app.post('/api/profiles', async (req, reply) => {
    const b = Body.safeParse(req.body);
    if (!b.success || !b.data.name) return reply.code(400).send({ error: 'invalid profile' });
    return createProfile(db, { ...b.data, name: b.data.name });
  });

  app.put('/api/profiles/:id', async (req, reply) => {
    const b = Body.safeParse(req.body);
    const id = idOf(req);
    if (!b.success || !getProfile(db, id)) return reply.code(400).send({ error: 'invalid profile' });
    return updateProfile(db, id, b.data);
  });

  app.post('/api/profiles/:id/duplicate', async (req, reply) => {
    const id = idOf(req);
    if (!getProfile(db, id)) return reply.code(404).send({ error: 'not found' });
    return duplicateProfile(db, id);
  });

  app.delete('/api/profiles/:id', async (req, reply) => {
    try {
      deleteProfile(db, idOf(req));
    } catch (e) {
      return reply.code(409).send({ error: e instanceof Error ? e.message : 'cannot delete' });
    }
    return { ok: true };
  });
}
