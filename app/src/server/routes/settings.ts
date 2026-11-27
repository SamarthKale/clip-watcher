import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { getSettings, setSettings } from '../settings.js';
import { AiError } from '../ai/provider.js';

export const GEMINI_SECRET = 'geminiApiKey';

export function registerSettingsRoutes(app: FastifyInstance): void {
  const { db, secrets } = app.deps;

  const view = async () => ({ ...getSettings(db), geminiKeySet: (await secrets.get(GEMINI_SECRET)) !== null });

  app.get('/api/settings', async () => view());

  app.put('/api/settings', async (req, reply) => {
    try {
      setSettings(db, req.body);
    } catch {
      return reply.code(400).send({ error: 'invalid settings' });
    }
    return view();
  });

  // Sends one tiny text request so problems (wrong key, quota, retired or busy model) show up here, in plain words.
  app.post('/api/settings/test-gemini', async (_req, reply) => {
    const provider = await app.deps.getProvider();
    if (!provider) return reply.code(409).send({ error: 'No Gemini API key is saved yet. Paste one above and press Save key.' });
    const t0 = Date.now();
    try {
      await provider.generate({ systemPrompt: 'Reply with only the JSON {"ok":true}.', userText: 'ping', frames: [] });
      return { ok: true, model: provider.model, ms: Date.now() - t0 };
    } catch (e) {
      const status = e instanceof AiError ? e.status : undefined;
      const day = e instanceof AiError && e.quotaScope === 'day';
      const hours = e instanceof AiError && e.retryAfterMs ? Math.max(1, Math.round(e.retryAfterMs / 3_600_000)) : null;
      const hint =
        status === 429 ? (day ? `This model's daily free quota is used up${hours ? ` (resets in about ${hours} h)` : ''}. Pick another model below, for example gemini-flash-lite-latest, or try again later.` : 'This model is rate limited right now. Wait a minute and try again, or pick another model below.')
        : status === 404 ? 'Google no longer offers this model to your key. Choose another model.'
        : status === 401 || status === 403 ? 'Google rejected the API key. Check it in Google AI Studio and save it again.'
        : status === 503 ? 'The model is overloaded at the moment. Try again shortly, or choose another model.'
        : 'Try another model, or check your internet connection.';
      return { ok: false, model: provider.model, ms: Date.now() - t0, status, error: e instanceof Error ? e.message : String(e), hint };
    }
  });

  // Write-only: the key is never returned by any route.
  app.put('/api/settings/gemini-key', async (req, reply) => {
    const body = z.object({ key: z.string().min(8).max(500) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid key' });
    await secrets.set(GEMINI_SECRET, body.data.key.trim());
    return { ok: true, geminiKeySet: true };
  });

  app.delete('/api/settings/gemini-key', async () => {
    await secrets.delete(GEMINI_SECRET);
    return { ok: true, geminiKeySet: false };
  });
}
