import fs from 'node:fs';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { addFolder, listFolders, removeFolder, updateFolder } from '../folders/folderRepo.js';
import { applyManifest, parseManifest } from '../manifest/manifest.js';
import { getSettings } from '../settings.js';

const AddBody = z.object({ path: z.string().min(1), recursive: z.boolean().optional() });
const PatchBody = z
  .object({
    display_name: z.string().min(1).max(200),
    recursive_scan: z.number().int().min(0).max(1),
    monitor_enabled: z.number().int().min(0).max(1),
    ai_profile_id: z.number().int().nullable(),
    auto_publish: z.number().int().min(0).max(1),
    default_visibility: z.enum(['public', 'unlisted', 'private']),
    default_category_id: z.string().min(1).max(10),
    default_playlist_id: z.string().nullable(),
  })
  .partial()
  .strict();

/**
 * Whether a folder is reachable. Async with a timeout so an offline network share cannot block the
 * event loop (and with it uploads and the UI).
 */
export async function checkAvailable(
  p: string,
  timeoutMs = 2000,
  stat: (p: string) => Promise<fs.Stats> = (x) => fs.promises.stat(x),
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const s = await Promise.race([
      stat(p),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out')), timeoutMs);
      }),
    ]);
    return s.isDirectory();
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function registerFolderRoutes(app: FastifyInstance): void {
  const { db } = app.deps;

  app.get('/api/folders', async () => Promise.all(listFolders(db).map(async (f) => ({ ...f, available: await checkAvailable(f.path) }))));

  app.post('/api/folders', async (req, reply) => {
    const body = AddBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid body' });
    if (!(await checkAvailable(body.data.path, 5000))) return reply.code(400).send({ error: 'folder does not exist or is not a directory' });
    return addFolder(db, body.data);
  });

  app.post('/api/folders/pick', async (_req, reply) => {
    const picked = await app.deps.pickFolder();
    if (!picked) return reply.code(204).send();
    if (!(await checkAvailable(picked, 5000))) return reply.code(400).send({ error: 'folder does not exist' });
    return addFolder(db, { path: picked });
  });

  // Upload a clip JSON (title/description/hashtags per file) from the browser and apply it to this folder's videos.
  app.post('/api/folders/:id/import-metadata', { bodyLimit: 20 * 1024 * 1024 }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id) || !db.prepare('SELECT 1 FROM folders WHERE id = ? AND is_enabled = 1').get(id)) {
      return reply.code(404).send({ error: 'folder not found' });
    }
    let clips;
    try {
      clips = parseManifest(req.body);
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : 'not a clip manifest' });
    }
    if (!clips.length) return reply.code(400).send({ error: 'The JSON has no clips with a file name and a title' });
    // Improving with Gemini is optional: the import itself always works.
    const wantsEnhance = (req.query as { enhance?: string }).enhance === '1';
    const geminiReady = getSettings(db).aiConsent && !!(await app.deps.getProvider());
    const result = applyManifest(db, id, clips, { enhance: wantsEnhance && geminiReady });
    return wantsEnhance && !geminiReady
      ? { ...result, enhanceSkipped: 'Gemini is not set up yet: add your API key and tick the consent box in Settings to improve the text.' }
      : result;
  });

  app.patch('/api/folders/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const body = PatchBody.safeParse(req.body);
    if (!body.success || !Number.isInteger(id)) return reply.code(400).send({ error: 'invalid body' });
    return updateFolder(db, id, body.data);
  });

  app.delete('/api/folders/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'invalid id' });
    removeFolder(db, id);
    return { ok: true };
  });
}
