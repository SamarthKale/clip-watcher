import type { Db } from '../db/db.js';
import { logActivity } from '../activity.js';
import { log } from '../log.js';
import type { SecretStore } from '../secrets/secretStore.js';
import { OAuthError, refreshAccessToken, type GoogleEndpoints, type Tokens } from './oauth.js';

/** The refresh token was revoked or expired: the user must reconnect. Not retryable. */
export class AuthRevokedError extends Error {
  constructor(message = 'Google access was revoked or expired; reconnect the channel in Accounts & Channels') {
    super(message);
    this.name = 'AuthRevokedError';
  }
}

export interface AccountAuthDeps {
  db: Db;
  secrets: SecretStore;
  endpoints: GoogleEndpoints;
  getClient: () => { clientId: string; clientSecret?: string } | Promise<{ clientId: string; clientSecret?: string }>;
  now?: () => number;
}

export interface AccountAuth {
  /** Stores a freshly authorised account (refresh token goes to the secret store only). Returns the account id. */
  complete(tokens: Tokens, channel: { id: string; title: string }): Promise<number>;
  getAccessToken(accountId: number): Promise<string>;
}

const REFRESH_MARGIN_MS = 60_000;

export function createAccountAuth(deps: AccountAuthDeps): AccountAuth {
  const { db, secrets } = deps;
  const now = deps.now ?? Date.now;
  const cache = new Map<number, { token: string; expiresAt: number }>();
  const inflight = new Map<number, Promise<string>>();

  async function refresh(accountId: number): Promise<string> {
    const row = db.prepare('SELECT secret_ref, is_enabled FROM youtube_accounts WHERE id = ?').get(accountId) as
      | { secret_ref: string | null; is_enabled: number }
      | undefined;
    if (!row || !row.is_enabled || !row.secret_ref) throw new AuthRevokedError();
    const refreshToken = await secrets.get(row.secret_ref);
    if (!refreshToken) throw new AuthRevokedError();
    const client = await deps.getClient();
    try {
      const r = await refreshAccessToken({ ...client, endpoints: deps.endpoints }, refreshToken);
      const entry = { token: r.accessToken, expiresAt: now() + r.expiresInSec * 1000 };
      cache.set(accountId, entry);
      db.prepare("UPDATE youtube_accounts SET last_validated_at = datetime('now') WHERE id = ?").run(accountId);
      return entry.token;
    } catch (e) {
      if (e instanceof OAuthError && e.code === 'invalid_grant') {
        cache.delete(accountId);
        db.prepare('UPDATE youtube_accounts SET is_enabled = 0, confirmed = 0 WHERE id = ?').run(accountId);
        logActivity(db, 'account', accountId, 'auth_revoked', 'Google access was revoked or expired');
        log.warn('google authorization revoked', { accountId });
        throw new AuthRevokedError();
      }
      throw e; // network trouble or a 5xx: transient, the account stays enabled
    }
  }

  return {
    async complete(tokens, channel) {
      const existing = db.prepare('SELECT id FROM youtube_accounts WHERE channel_id = ?').get(channel.id) as { id: number } | undefined;
      let id: number;
      if (existing) {
        id = existing.id;
        db.prepare('UPDATE youtube_accounts SET channel_title = ?, google_account_label = ?, is_enabled = 1, confirmed = 0 WHERE id = ?').run(channel.title, channel.title, id);
      } else {
        id = Number(db.prepare('INSERT INTO youtube_accounts(google_account_label, channel_id, channel_title) VALUES(?,?,?)').run(channel.title, channel.id, channel.title).lastInsertRowid);
      }
      const ref = `youtube-refresh-${id}`;
      await secrets.set(ref, tokens.refreshToken);
      db.prepare('UPDATE youtube_accounts SET secret_ref = ?, last_validated_at = datetime(\'now\') WHERE id = ?').run(ref, id);
      cache.set(id, { token: tokens.accessToken, expiresAt: tokens.expiresAt });
      logActivity(db, 'account', id, 'connected', `Connected channel ${channel.title}`);
      return id;
    },

    async getAccessToken(accountId) {
      const hit = cache.get(accountId);
      if (hit && hit.expiresAt - now() > REFRESH_MARGIN_MS) return hit.token;
      const pending = inflight.get(accountId);
      if (pending) return pending;
      const p = refresh(accountId).finally(() => inflight.delete(accountId));
      inflight.set(accountId, p);
      return p;
    },
  };
}
