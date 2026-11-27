import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import path from 'node:path';
import { openDb, type Db } from '../../src/server/db/db.js';
import { buildApp } from '../../src/server/app.js';
import { createSecretStore, type SecretStore } from '../../src/server/secrets/secretStore.js';
import { beginOAuth, exchangeCode, pkcePair, fetchOwnChannel, SCOPES } from '../../src/server/youtube/oauth.js';
import { createAccountAuth, AuthRevokedError } from '../../src/server/youtube/accounts.js';
import { setSettings } from '../../src/server/settings.js';
import { startFakeGoogle, type FakeGoogle } from '../fixtures/fakeGoogle.js';
import { tempDir } from '../fixtures/make-fixtures.js';

const H = { 'x-localtube-token': 't' };
const fakeCrypto = {
  protect: async (s: string) => Buffer.from(s).toString('base64'),
  unprotect: async (s: string) => Buffer.from(s, 'base64').toString(),
};
let g: FakeGoogle;
let db: Db;
let secrets: SecretStore;
beforeEach(async () => {
  g = await startFakeGoogle();
  db = openDb(':memory:');
  secrets = createSecretStore(path.join(tempDir(), 's.json'), fakeCrypto);
});
afterEach(() => g.close());

const client = () => ({ clientId: 'client-1', clientSecret: undefined as string | undefined });
const makeAuth = (now?: () => number) => createAccountAuth({ db, secrets, endpoints: g.endpoints, getClient: client, now });

describe('PKCE and loopback', () => {
  it('the challenge is the S256 of the verifier and the verifier is long enough', () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(challenge).toBe(crypto.createHash('sha256').update(verifier).digest('base64url'));
  });

  it('builds an auth URL with PKCE, state, offline access, least-privilege scopes and a 127.0.0.1 redirect', async () => {
    const { authUrl, done } = await beginOAuth({ clientId: 'client-1', endpoints: g.endpoints, timeoutMs: 200 });
    done.catch(() => undefined);
    const u = new URL(authUrl);
    expect(u.origin + u.pathname).toBe(g.endpoints.authUrl);
    expect(u.searchParams.get('client_id')).toBe('client-1');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('code_challenge')).toBeTruthy();
    expect(u.searchParams.get('state')!.length).toBeGreaterThan(15);
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(new URL(u.searchParams.get('redirect_uri')!).hostname).toBe('127.0.0.1');
    expect(u.searchParams.get('scope')!.split(' ').sort()).toEqual([...SCOPES].sort());
    expect(SCOPES).toEqual(['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly']);
  });

  it('a callback with the wrong state is rejected with 400 and does not finish the flow; the right state does', async () => {
    const { authUrl, done } = await beginOAuth({ clientId: 'client-1', endpoints: g.endpoints });
    const u = new URL(authUrl);
    const redirect = u.searchParams.get('redirect_uri')!;
    const bad = await fetch(`${redirect}?code=EVIL&state=wrong`);
    expect(bad.status).toBe(400);
    const good = await fetch(`${redirect}?code=GOOD&state=${u.searchParams.get('state')}`);
    expect(good.status).toBe(200);
    const r = await done;
    expect(r.code).toBe('GOOD');
    expect(r.redirectUri).toBe(redirect);
    expect(r.verifier.length).toBeGreaterThanOrEqual(43);
  });

  it('an access_denied callback rejects the flow', async () => {
    const { authUrl, done } = await beginOAuth({ clientId: 'client-1', endpoints: g.endpoints });
    const u = new URL(authUrl);
    const settled = done.then(() => 'resolved', (e: Error) => e.message);
    await fetch(`${u.searchParams.get('redirect_uri')}?error=access_denied&state=${u.searchParams.get('state')}`);
    expect(await settled).toMatch(/access_denied|denied/i);
  });

  it('times out and frees the port when nobody completes the flow', async () => {
    const { done } = await beginOAuth({ clientId: 'client-1', endpoints: g.endpoints, timeoutMs: 50 });
    await expect(done).rejects.toThrow(/timed out/i);
  });
});

describe('token exchange', () => {
  it('posts the code with the PKCE verifier and redirect, and omits client_secret when none is set', async () => {
    const t = await exchangeCode({ clientId: 'client-1', endpoints: g.endpoints }, { code: 'C', verifier: 'V'.repeat(50), redirectUri: 'http://127.0.0.1:9/callback' });
    expect(t).toMatchObject({ accessToken: 'AT-first', refreshToken: 'RT-secret-1' });
    const b = g.exchangeBodies[0];
    expect(b.get('code_verifier')).toBe('V'.repeat(50));
    expect(b.get('grant_type')).toBe('authorization_code');
    expect(b.get('redirect_uri')).toBe('http://127.0.0.1:9/callback');
    expect(b.has('client_secret')).toBe(false);
  });

  it('includes client_secret only when configured', async () => {
    await exchangeCode({ clientId: 'c', clientSecret: 'not-really-secret', endpoints: g.endpoints }, { code: 'C', verifier: 'V'.repeat(50), redirectUri: 'http://127.0.0.1:9/callback' });
    expect(g.exchangeBodies[0].get('client_secret')).toBe('not-really-secret');
  });

  it('fetchOwnChannel returns id and title, and throws when the account has no channel', async () => {
    expect(await fetchOwnChannel('AT-x', g.endpoints)).toEqual({ id: 'UC123', title: 'My Channel' });
    g.channel = null;
    await expect(fetchOwnChannel('AT-x', g.endpoints)).rejects.toThrow(/no youtube channel/i);
  });
});

describe('account auth', () => {
  async function account(expiresInSec: number, now = () => 1_000_000) {
    const auth = makeAuth(now);
    const id = await auth.complete({ accessToken: 'AT-first', refreshToken: 'RT-secret-1', expiresAt: now() + expiresInSec * 1000 }, { id: 'UC123', title: 'My Channel' });
    return { auth, id };
  }

  it('refreshes a token expiring in 30 s, exactly once', async () => {
    const { auth, id } = await account(30);
    expect(await auth.getAccessToken(id)).toBe('AT-refreshed-1');
    expect(await auth.getAccessToken(id)).toBe('AT-refreshed-1');
    expect(g.refreshCalls).toBe(1);
  });

  it('does not refresh a token with 10 minutes left', async () => {
    const { auth, id } = await account(600);
    expect(await auth.getAccessToken(id)).toBe('AT-first');
    expect(g.refreshCalls).toBe(0);
  });

  it('concurrent callers share one refresh', async () => {
    const { auth, id } = await account(5);
    const tokens = await Promise.all([auth.getAccessToken(id), auth.getAccessToken(id), auth.getAccessToken(id)]);
    expect(new Set(tokens).size).toBe(1);
    expect(g.refreshCalls).toBe(1);
  });

  it('invalid_grant disables the account, throws AuthRevokedError, and stops calling Google', async () => {
    const { auth, id } = await account(5);
    g.revoked = true;
    await expect(auth.getAccessToken(id)).rejects.toBeInstanceOf(AuthRevokedError);
    expect((db.prepare('SELECT is_enabled, confirmed FROM youtube_accounts WHERE id=?').get(id) as any)).toEqual({ is_enabled: 0, confirmed: 0 });
    await expect(auth.getAccessToken(id)).rejects.toBeInstanceOf(AuthRevokedError);
    expect(g.refreshCalls).toBe(1);
  });

  it('stores the refresh token only in the secret store, never in SQLite', async () => {
    const { id } = await account(600);
    const row = db.prepare('SELECT * FROM youtube_accounts WHERE id=?').get(id) as Record<string, unknown>;
    expect(JSON.stringify(row)).not.toContain('RT-secret-1');
    expect(row.secret_ref).toBeTruthy();
    expect(await secrets.get(row.secret_ref as string)).toBe('RT-secret-1');
  });

  it('a transient failure (server down) is not treated as revoked', async () => {
    const { auth, id } = await account(5);
    await g.close();
    const err = await auth.getAccessToken(id).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(AuthRevokedError);
    expect((db.prepare('SELECT is_enabled FROM youtube_accounts WHERE id=?').get(id) as any).is_enabled).toBe(1);
    g = await startFakeGoogle();
  });
});

describe('account routes', () => {
  it('connect -> browser callback -> account appears unconfirmed -> confirm -> disconnect; no token ever in a response', async () => {
    setSettings(db, { googleClientId: 'client-1' });
    const app = buildApp({ db, token: 't', secrets, oauthEndpoints: g.endpoints });
    const bodies: string[] = [];

    const start = await app.inject({ method: 'POST', url: '/api/accounts/connect', headers: H });
    expect(start.statusCode).toBe(200);
    bodies.push(start.body);
    const u = new URL(start.json().authUrl);
    await fetch(`${u.searchParams.get('redirect_uri')}?code=C&state=${u.searchParams.get('state')}`);

    let list: any;
    for (let i = 0; i < 100; i++) {
      const r = await app.inject({ method: 'GET', url: '/api/accounts', headers: H });
      bodies.push(r.body);
      list = r.json();
      if (list.accounts.length) break;
      await new Promise((res) => setTimeout(res, 20));
    }
    expect(list.accounts).toHaveLength(1);
    expect(list.accounts[0]).toMatchObject({ channel_id: 'UC123', channel_title: 'My Channel', confirmed: 0 });

    const id = list.accounts[0].id;
    const conf = await app.inject({ method: 'POST', url: `/api/accounts/${id}/confirm`, headers: H });
    expect(conf.statusCode).toBe(200);
    expect((db.prepare('SELECT confirmed FROM youtube_accounts WHERE id=?').get(id) as any).confirmed).toBe(1);

    const del = await app.inject({ method: 'DELETE', url: `/api/accounts/${id}`, headers: H });
    expect(del.statusCode).toBe(200);
    expect(del.json().guidance).toMatch(/myaccount\.google\.com\/permissions/);
    bodies.push(del.body);
    expect(await secrets.get(`youtube-refresh-${id}`)).toBeNull();
    expect((db.prepare('SELECT is_enabled, confirmed FROM youtube_accounts WHERE id=?').get(id) as any)).toEqual({ is_enabled: 0, confirmed: 0 });

    for (const b of bodies) {
      expect(b).not.toContain('RT-secret-1');
      expect(b).not.toContain('AT-first');
    }
  });

  it('connect without a configured client id is a 400 with a helpful message', async () => {
    const app = buildApp({ db, token: 't', secrets, oauthEndpoints: g.endpoints });
    const r = await app.inject({ method: 'POST', url: '/api/accounts/connect', headers: H });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/client id/i);
  });

  it('confirming a second channel unconfirms the first (one active channel)', async () => {
    const auth = makeAuth();
    const a = await auth.complete({ accessToken: 'a', refreshToken: 'r1', expiresAt: Date.now() + 1e6 }, { id: 'UC1', title: 'One' });
    const b = await auth.complete({ accessToken: 'a', refreshToken: 'r2', expiresAt: Date.now() + 1e6 }, { id: 'UC2', title: 'Two' });
    const app = buildApp({ db, token: 't', secrets, oauthEndpoints: g.endpoints });
    await app.inject({ method: 'POST', url: `/api/accounts/${a}/confirm`, headers: H });
    await app.inject({ method: 'POST', url: `/api/accounts/${b}/confirm`, headers: H });
    const rows = db.prepare('SELECT id, confirmed FROM youtube_accounts ORDER BY id').all();
    expect(rows).toEqual([{ id: a, confirmed: 0 }, { id: b, confirmed: 1 }]);
  });

  it('saves the OAuth client id (and optional secret) without echoing the secret', async () => {
    const app = buildApp({ db, token: 't', secrets, oauthEndpoints: g.endpoints });
    const r = await app.inject({ method: 'PUT', url: '/api/accounts/oauth-client', headers: H, payload: { clientId: 'abc.apps.googleusercontent.com', clientSecret: 'GOCSPX-shh' } });
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain('GOCSPX-shh');
    expect(await secrets.get('googleClientSecret')).toBe('GOCSPX-shh');
  });
});
