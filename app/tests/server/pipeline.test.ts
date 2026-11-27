import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { openDb } from '../../src/server/db/db.js';
import { buildApp } from '../../src/server/app.js';

const H = { 'x-localtube-token': 't' };
let fake: http.Server;
const seen: { method?: string; url?: string; body?: string; range?: string }[] = [];

beforeAll(async () => {
  fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body, range: req.headers.range as string | undefined });
      if (req.url?.startsWith('/media/')) {
        res.writeHead(206, { 'content-type': 'video/mp4', 'content-range': 'bytes 0-3/10', 'accept-ranges': 'bytes', 'content-length': '4' });
        return res.end('abcd');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, url: req.url, body }));
    });
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  process.env.PIPELINE_URL = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
});
afterAll(() => {
  delete process.env.PIPELINE_URL;
  fake.close();
});

const app = () => buildApp({ db: openDb(':memory:'), token: 't' });

describe('pipeline proxy', () => {
  it('requires the same token as every other /api route', async () => {
    const a = app();
    expect((await a.inject({ method: 'GET', url: '/api/pipeline/state' })).statusCode).toBe(401);
    expect((await a.inject({ method: 'POST', url: '/api/pipeline/start', payload: {} })).statusCode).toBe(401);
    await a.close();
  });

  it('forwards allowed GETs with their query string', async () => {
    const a = app();
    const r = await a.inject({ method: 'GET', url: '/api/pipeline/state?channel=abc', headers: H });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, url: '/api/state?channel=abc' });
    await a.close();
  });

  it('forwards allowed POST bodies', async () => {
    const a = app();
    const r = await a.inject({ method: 'POST', url: '/api/pipeline/vod/add', headers: H, payload: { url: 'https://youtu.be/x' } });
    expect(JSON.parse(r.json().body)).toEqual({ url: 'https://youtu.be/x' });
    await a.close();
  });

  it('only forwards the fixed list of endpoints', async () => {
    const a = app();
    for (const url of ['/api/pipeline/secrets', '/api/pipeline/..%2f..%2fconfig', '/api/pipeline/state%2f..%2fx']) {
      expect([404, 400]).toContain((await a.inject({ method: 'GET', url, headers: H })).statusCode);
    }
    expect((await a.inject({ method: 'POST', url: '/api/pipeline/format-drive', headers: H, payload: {} })).statusCode).toBe(404);
    await a.close();
  });

  it('streams Shorts with range support and refuses other files', async () => {
    const a = app();
    const r = await a.inject({ method: 'GET', url: '/api/pipeline-media/abc-1795000000/short.mp4', headers: { ...H, range: 'bytes=0-3' } });
    expect(r.statusCode).toBe(206);
    expect(r.headers['content-range']).toBe('bytes 0-3/10');
    expect(r.body).toBe('abcd');
    expect(seen.at(-1)?.range).toBe('bytes=0-3');
    for (const url of ['/api/pipeline-media/abc/config.toml', '/api/pipeline-media/..%2fx/short.mp4']) {
      expect((await a.inject({ method: 'GET', url, headers: H })).statusCode).toBe(404);
    }
    await a.close();
  });

  it('says the pipeline is offline (502) instead of failing', async () => {
    const saved = process.env.PIPELINE_URL;
    process.env.PIPELINE_URL = 'http://127.0.0.1:9';
    const a = app();
    const r = await a.inject({ method: 'GET', url: '/api/pipeline/state', headers: H });
    expect(r.statusCode).toBe(502);
    expect(r.json().error).toBe('pipeline offline');
    process.env.PIPELINE_URL = saved;
    await a.close();
  });
});
