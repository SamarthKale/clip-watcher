import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { GeminiProvider } from '../../src/server/ai/gemini.js';
import { AiError } from '../../src/server/ai/provider.js';

interface Seen {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}
let server: http.Server | undefined;
afterEach(() => server?.close());

async function fake(handler: (seen: Seen, res: http.ServerResponse) => void): Promise<{ baseUrl: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const s: Seen = { url: req.url ?? '', headers: req.headers, body: raw ? JSON.parse(raw) : null };
      seen.push(s);
      handler(s, res);
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return { baseUrl: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, seen };
}
const okText = (text: string) => (_s: Seen, res: http.ServerResponse) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] }));
};
async function failure(p: Promise<unknown>): Promise<AiError> {
  try {
    await p;
  } catch (e) {
    return e as AiError;
  }
  throw new Error('expected the call to fail');
}
const input = { systemPrompt: 'SYS', userText: 'USER', frames: [Buffer.from('frame1'), Buffer.from('frame2')] };

describe('GeminiProvider', () => {
  it('sends system prompt, text and inline image frames; parses JSON; keeps the key in a header', async () => {
    const { baseUrl, seen } = await fake(okText('{"title":"T"}'));
    const out = await new GeminiProvider('KEY-123456789', 'gemini-test', { baseUrl }).generate(input);
    expect(out).toEqual({ title: 'T' });
    const s = seen[0];
    expect(s.url).toContain('/models/gemini-test:generateContent');
    expect(s.url).not.toContain('KEY-123456789');
    expect(s.headers['x-goog-api-key']).toBe('KEY-123456789');
    expect(s.body.systemInstruction.parts[0].text).toBe('SYS');
    const parts = s.body.contents[0].parts;
    expect(parts[0].text).toBe('USER');
    const images = parts.filter((p: any) => p.inlineData);
    expect(images).toHaveLength(2);
    expect(images[0].inlineData.mimeType).toBe('image/jpeg');
    expect(Buffer.from(images[0].inlineData.data, 'base64').toString()).toBe('frame1');
    expect(s.body.generationConfig.responseMimeType).toBe('application/json');
  });

  it('returns the raw text when the model output is not JSON, so validation can reject it', async () => {
    const { baseUrl } = await fake(okText('{"title": "cut off'));
    const out = await new GeminiProvider('KEY-123456789', 'm', { baseUrl }).generate(input);
    expect(out).toBe('{"title": "cut off');
  });

  it('429 and 503 are retryable AiErrors', async () => {
    for (const status of [429, 503]) {
      const { baseUrl } = await fake((_s, res) => {
        res.statusCode = status;
        res.end('{"error":{"message":"slow down"}}');
      });
      const err = await failure(new GeminiProvider('KEY-123456789', 'm', { baseUrl }).generate(input));
      expect(err).toBeInstanceOf(AiError);
      expect(err.retryable).toBe(true);
      expect(err.status).toBe(status);
      server!.close();
    }
  });

  it('a per-day quota 429 is not retryable, and carries the quota scope and reset time', async () => {
    const { baseUrl } = await fake((_s, res) => {
      res.statusCode = 429;
      res.end(JSON.stringify({ error: { code: 429, message: 'You exceeded your current quota', details: [
        { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] },
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '34544s' },
      ] } }));
    });
    const err = await failure(new GeminiProvider('KEY-123456789', 'm', { baseUrl }).generate(input));
    expect(err.status).toBe(429);
    expect(err.retryable).toBe(false);
    expect(err.quotaScope).toBe('day');
    expect(err.retryAfterMs).toBe(34544000);
  });

  it('a per-minute quota 429 stays retryable and carries the suggested delay', async () => {
    const { baseUrl } = await fake((_s, res) => {
      res.statusCode = 429;
      res.end(JSON.stringify({ error: { code: 429, message: 'slow down', details: [
        { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }] },
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '12.5s' },
      ] } }));
    });
    const err = await failure(new GeminiProvider('KEY-123456789', 'm', { baseUrl }).generate(input));
    expect(err.retryable).toBe(true);
    expect(err.quotaScope).toBe('minute');
    expect(err.retryAfterMs).toBe(12500);
  });

  it('a plain 429 without details is still retryable', async () => {
    const { baseUrl } = await fake((_s, res) => { res.statusCode = 429; res.end('{"error":{"message":"busy"}}'); });
    const err = await failure(new GeminiProvider('KEY-123456789', 'm', { baseUrl }).generate(input));
    expect(err.retryable).toBe(true);
    expect(err.quotaScope).toBeUndefined();
  });

  it('401 and 400 are not retryable and never echo the API key', async () => {
    for (const status of [400, 401, 403]) {
      const { baseUrl } = await fake((_s, res) => {
        res.statusCode = status;
        res.end('{"error":{"message":"bad key KEY-123456789"}}');
      });
      const err = await failure(new GeminiProvider('KEY-123456789', 'm', { baseUrl }).generate(input));
      expect(err).toBeInstanceOf(AiError);
      expect(err.retryable).toBe(false);
      expect(String(err.message)).not.toContain('KEY-123456789');
      server!.close();
    }
  });

  it('a safety-blocked prompt is a non-retryable AiError', async () => {
    const { baseUrl } = await fake((_s, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }));
    });
    const err = await failure(new GeminiProvider('KEY-123456789', 'm', { baseUrl }).generate(input));
    expect(err).toBeInstanceOf(AiError);
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/block/i);
  });

  it('a network failure is a retryable AiError', async () => {
    const err = await failure(new GeminiProvider('KEY-123456789', 'm', { baseUrl: 'http://127.0.0.1:1' }).generate(input));
    expect(err).toBeInstanceOf(AiError);
    expect(err.retryable).toBe(true);
  });
});
