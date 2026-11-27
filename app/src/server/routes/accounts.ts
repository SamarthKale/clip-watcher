import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { getSettings, setSettings } from '../settings.js';
import { beginOAuth, exchangeCode, fetchOwnChannel } from '../youtube/oauth.js';
import { log } from '../log.js';

export const CLIENT_SECRET_NAME = 'googleClientSecret';
const REVOKE_GUIDANCE =
  'LocalTube has forgotten this channel. To fully remove its access, open https://myaccount.google.com/permissions , choose LocalTube, and select "Remove access".';

export function registerAccountRoutes(app: FastifyInstance): void {
  const { db, secrets, auth } = app.deps;
  let pending: { state: 'waiting' | 'error'; message?: string } | null = null;

  app.get('/api/accounts', async () => ({
    clientIdSet: !!getSettings(db).googleClientId,
    pending,
    accounts: db
      .prepare(
        `SELECT id, channel_id, channel_title, confirmed, is_enabled, connected_at, last_validated_at,
                CASE WHEN is_enabled = 0 THEN 1 ELSE 0 END AS needs_reauth
         FROM youtube_accounts WHERE is_enabled = 1 OR secret_ref IS NOT NULL ORDER BY id`,
      )
      .all(),
  }));

  app.put('/api/accounts/oauth-client', async (req, reply) => {
    const b = z.object({ clientId: z.string().min(5).max(300), clientSecret: z.string().min(1).max(300).optional() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid client id' });
    setSettings(db, { googleClientId: b.data.clientId.trim() });
    if (b.data.clientSecret) await secrets.set(CLIENT_SECRET_NAME, b.data.clientSecret.trim());
    return { ok: true, clientIdSet: true };
  });

  app.post('/api/accounts/connect', async (_req, reply) => {
    const clientId = getSettings(db).googleClientId;
    if (!clientId) return reply.code(400).send({ error: 'Set your Google OAuth client ID in Accounts & Channels first' });
    const clientSecret = (await secrets.get(CLIENT_SECRET_NAME)) ?? undefined;
    const endpoints = app.deps.oauthEndpoints;
    const { authUrl, done } = await beginOAuth({ clientId, endpoints });
    pending = { state: 'waiting' };
    done
      .then(async (r) => {
        const tokens = await exchangeCode({ clientId, clientSecret, endpoints }, r);
        const channel = await fetchOwnChannel(tokens.accessToken, endpoints);
        await auth.complete(tokens, channel);
        pending = null;
      })
      .catch((e) => {
        pending = { state: 'error', message: e instanceof Error ? e.message : String(e) };
        log.warn('google connect failed', { error: pending.message });
      });
    return { authUrl };
  });

  // Explicit user confirmation of the channel that bulk uploads will go to.
  app.post('/api/accounts/:id/confirm', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const acct = db.prepare('SELECT is_enabled FROM youtube_accounts WHERE id = ?').get(id) as { is_enabled: number } | undefined;
    if (!acct) return reply.code(404).send({ error: 'not found' });
    if (!acct.is_enabled) return reply.code(409).send({ error: 'This account needs to be reconnected first' });
    db.transaction(() => {
      db.prepare('UPDATE youtube_accounts SET confirmed = 0').run();
      db.prepare('UPDATE youtube_accounts SET confirmed = 1 WHERE id = ?').run(id);
    })();
    return { ok: true };
  });

  app.delete('/api/accounts/:id', async (req) => {
    const id = Number((req.params as { id: string }).id);
    const row = db.prepare('SELECT secret_ref FROM youtube_accounts WHERE id = ?').get(id) as { secret_ref: string | null } | undefined;
    if (row?.secret_ref) await secrets.delete(row.secret_ref);
    db.prepare('UPDATE youtube_accounts SET is_enabled = 0, confirmed = 0, secret_ref = NULL WHERE id = ?').run(id);
    return { ok: true, guidance: REVOKE_GUIDANCE };
  });
}
