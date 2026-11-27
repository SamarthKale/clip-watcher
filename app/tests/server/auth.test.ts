import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/server/db/db.js';
import { buildApp } from '../../src/server/app.js';
import { redact } from '../../src/server/log.js';

describe('auth', () => {
  it('401 without token, 200 with token', async () => {
    const app = buildApp({ db: openDb(':memory:'), token: 't0k' });
    expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(401);
    const ok = await app.inject({ method: 'GET', url: '/api/health', headers: { 'x-localtube-token': 't0k' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true });
  });

  it('rejects requests whose Host header is not localhost (DNS rebinding defence), even with the token', async () => {
    const app = buildApp({ db: openDb(':memory:'), token: 't0k' });
    const bad = await app.inject({ method: 'GET', url: '/api/health', headers: { 'x-localtube-token': 't0k', host: 'evil.example.com' } });
    expect(bad.statusCode).toBe(403);
    for (const host of ['127.0.0.1:4317', 'localhost:4317', 'localhost']) {
      const ok = await app.inject({ method: 'GET', url: '/api/health', headers: { 'x-localtube-token': 't0k', host } });
      expect(ok.statusCode, host).toBe(200);
    }
  });

  it('sends a restrictive Content-Security-Policy and nosniff on every response', async () => {
    const app = buildApp({ db: openDb(':memory:'), token: 't0k' });
    const r = await app.inject({ method: 'GET', url: '/api/health', headers: { 'x-localtube-token': 't0k' } });
    expect(r.headers['content-security-policy']).toContain("default-src 'self'");
    expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(r.headers['x-content-type-options']).toBe('nosniff');
  });

  describe('session cookie (survives refresh, new tabs and restarts)', () => {
    const LAUNCH = { 'x-localtube-token': 't0k' };
    const cookieOf = (setCookie: unknown) => String(setCookie).split(';')[0];

    it('login with the launch token sets an HttpOnly SameSite=Strict cookie', async () => {
      const app = buildApp({ db: openDb(':memory:'), token: 't0k', sessionSecret: 'persisted-secret' });
      const r = await app.inject({ method: 'POST', url: '/api/session/login', headers: LAUNCH });
      expect(r.statusCode).toBe(200);
      const sc = String(r.headers['set-cookie']);
      expect(sc).toMatch(/^lt_session=/);
      expect(sc).toMatch(/HttpOnly/i);
      expect(sc).toMatch(/SameSite=Strict/i);
      expect(sc).toMatch(/Path=\//);
      expect(sc).not.toContain('t0k'); // the cookie is not the launch token
    });

    it('login without any credential is rejected', async () => {
      const app = buildApp({ db: openDb(':memory:'), token: 't0k', sessionSecret: 's' });
      expect((await app.inject({ method: 'POST', url: '/api/session/login' })).statusCode).toBe(401);
    });

    it('the cookie plus the UI client header authenticates without the launch token', async () => {
      const app = buildApp({ db: openDb(':memory:'), token: 't0k', sessionSecret: 'persisted-secret' });
      const login = await app.inject({ method: 'POST', url: '/api/session/login', headers: LAUNCH });
      const cookie = cookieOf(login.headers['set-cookie']);
      const ok = await app.inject({ method: 'GET', url: '/api/health', headers: { cookie, 'x-localtube-client': 'ui' } });
      expect(ok.statusCode).toBe(200);
    });

    it('a cookie alone, without the client header, is rejected (cross-site request forgery guard)', async () => {
      const app = buildApp({ db: openDb(':memory:'), token: 't0k', sessionSecret: 'persisted-secret' });
      const login = await app.inject({ method: 'POST', url: '/api/session/login', headers: LAUNCH });
      const cookie = cookieOf(login.headers['set-cookie']);
      expect((await app.inject({ method: 'GET', url: '/api/health', headers: { cookie } })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: '/api/queue/pause', headers: { cookie } })).statusCode).toBe(401);
    });

    it('a wrong cookie value is rejected', async () => {
      const app = buildApp({ db: openDb(':memory:'), token: 't0k', sessionSecret: 'persisted-secret' });
      const r = await app.inject({ method: 'GET', url: '/api/health', headers: { cookie: 'lt_session=guess', 'x-localtube-client': 'ui' } });
      expect(r.statusCode).toBe(401);
    });

    it('a cookie issued before a restart still works after it (new launch token, same persisted secret)', async () => {
      const first = buildApp({ db: openDb(':memory:'), token: 'launch-1', sessionSecret: 'persisted-secret' });
      const login = await first.inject({ method: 'POST', url: '/api/session/login', headers: { 'x-localtube-token': 'launch-1' } });
      const cookie = cookieOf(login.headers['set-cookie']);
      const second = buildApp({ db: openDb(':memory:'), token: 'launch-2', sessionSecret: 'persisted-secret' });
      expect((await second.inject({ method: 'GET', url: '/api/health', headers: { cookie, 'x-localtube-client': 'ui' } })).statusCode).toBe(200);
      expect((await second.inject({ method: 'GET', url: '/api/health', headers: { 'x-localtube-token': 'launch-1' } })).statusCode).toBe(401);
    });

    it('the cookie does not bypass the Host check', async () => {
      const app = buildApp({ db: openDb(':memory:'), token: 't0k', sessionSecret: 'persisted-secret' });
      const login = await app.inject({ method: 'POST', url: '/api/session/login', headers: LAUNCH });
      const cookie = cookieOf(login.headers['set-cookie']);
      const r = await app.inject({ method: 'GET', url: '/api/health', headers: { cookie, 'x-localtube-client': 'ui', host: 'evil.example.com' } });
      expect(r.statusCode).toBe(403);
    });

    it('the encoded-path bypass is still closed with a cookie', async () => {
      const app = buildApp({ db: openDb(':memory:'), token: 't0k', sessionSecret: 'persisted-secret' });
      expect((await app.inject({ method: 'GET', url: '/%61pi/health' })).statusCode).toBe(401);
    });
  });

  it('redacts secrets from log context', () => {
    const out = JSON.stringify(redact({ access_token: 'abc', nested: { Authorization: 'Bearer zzz' }, keep: 'fine' }));
    expect(out).not.toContain('abc');
    expect(out).not.toContain('zzz');
    expect(out).toContain('fine');
  });
});
