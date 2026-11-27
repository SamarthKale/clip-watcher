import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface GoogleEndpoints {
  authUrl: string;
  tokenUrl: string;
  channelsUrl: string;
}

export const GOOGLE_ENDPOINTS: GoogleEndpoints = {
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  channelsUrl: 'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
};

/** Least-privilege scopes: upload, plus read-only to show the channel and check processing status. */
export const SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly'];

export interface OAuthClient {
  clientId: string;
  /** Desktop clients may be issued a non-confidential "secret". Treated as optional and never as a protection. */
  clientSecret?: string;
  endpoints: GoogleEndpoints;
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

/** Error from the token endpoint; `code` is Google's `error` field (e.g. invalid_grant). */
export class OAuthError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'OAuthError';
  }
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(48).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

export interface BeginResult {
  authUrl: string;
  done: Promise<{ code: string; verifier: string; redirectUri: string }>;
}

const PAGE = (msg: string) =>
  `<!doctype html><meta charset="utf-8"><title>LocalTube</title><body style="font-family:system-ui;padding:3rem"><h2>${msg}</h2><p>You can close this tab and return to LocalTube.</p></body>`;

/** Starts a one-shot loopback listener and returns the Google consent URL to open in the browser. */
export async function beginOAuth(cfg: { clientId: string; endpoints: GoogleEndpoints; timeoutMs?: number }): Promise<BeginResult> {
  const { verifier, challenge } = pkcePair();
  const state = crypto.randomBytes(24).toString('base64url');
  let finish!: (r: { code: string; verifier: string; redirectUri: string }) => void;
  let fail!: (e: Error) => void;
  const done = new Promise<{ code: string; verifier: string; redirectUri: string }>((res, rej) => {
    finish = res;
    fail = rej;
  });

  const server = http.createServer();
  let redirectUri = '';
  const cleanup = () => {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
  };
  const timer = setTimeout(() => {
    cleanup();
    fail(new Error('Google sign-in timed out; start the connection again'));
  }, cfg.timeoutMs ?? 5 * 60_000);

  server.on('request', (req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (u.pathname !== '/callback') {
      res.statusCode = 404;
      return res.end();
    }
    if (u.searchParams.get('state') !== state) {
      res.statusCode = 400; // stray or forged request: ignore and keep waiting
      return res.end(PAGE('Invalid sign-in response'));
    }
    const error = u.searchParams.get('error');
    const code = u.searchParams.get('code');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (error || !code) {
      res.end(PAGE('Sign-in was not completed'), () => cleanup());
      return fail(new Error(`Google authorization failed: ${error ?? 'no code returned'}`));
    }
    res.end(PAGE('LocalTube is connected'), () => cleanup());
    finish({ code, verifier, redirectUri });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`;

  const url = new URL(cfg.endpoints.authUrl);
  url.search = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
  }).toString();
  return { authUrl: url.toString(), done };
}

async function tokenRequest(cfg: OAuthClient, params: Record<string, string>): Promise<Record<string, unknown>> {
  const body = new URLSearchParams({ client_id: cfg.clientId, ...params });
  if (cfg.clientSecret) body.set('client_secret', cfg.clientSecret);
  const res = await fetch(cfg.endpoints.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    const code = typeof json.error === 'string' ? json.error : `http_${res.status}`;
    const desc = typeof json.error_description === 'string' ? json.error_description : '';
    throw new OAuthError(`Google token request failed (${code}${desc ? `: ${desc}` : ''})`, code);
  }
  return json;
}

export async function exchangeCode(cfg: OAuthClient, p: { code: string; verifier: string; redirectUri: string }): Promise<Tokens> {
  const j = await tokenRequest(cfg, { grant_type: 'authorization_code', code: p.code, code_verifier: p.verifier, redirect_uri: p.redirectUri });
  if (typeof j.access_token !== 'string' || typeof j.refresh_token !== 'string') {
    throw new OAuthError('Google did not return a refresh token; remove LocalTube from your Google account permissions and connect again', 'no_refresh_token');
  }
  return { accessToken: j.access_token, refreshToken: j.refresh_token, expiresAt: Date.now() + Number(j.expires_in ?? 3600) * 1000 };
}

export async function refreshAccessToken(cfg: OAuthClient, refreshToken: string): Promise<{ accessToken: string; expiresInSec: number }> {
  const j = await tokenRequest(cfg, { grant_type: 'refresh_token', refresh_token: refreshToken });
  if (typeof j.access_token !== 'string') throw new OAuthError('Google returned no access token', 'bad_response');
  return { accessToken: j.access_token, expiresInSec: Number(j.expires_in ?? 3600) };
}

export async function fetchOwnChannel(accessToken: string, endpoints: GoogleEndpoints): Promise<{ id: string; title: string }> {
  const res = await fetch(endpoints.channelsUrl, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Could not read your YouTube channel (HTTP ${res.status})`);
  const j = (await res.json()) as { items?: { id: string; snippet?: { title?: string } }[] };
  const ch = j.items?.[0];
  if (!ch) throw new Error('No YouTube channel found on this Google account. Create a channel first, then connect again.');
  return { id: ch.id, title: ch.snippet?.title ?? ch.id };
}
