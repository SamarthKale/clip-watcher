import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { startFakeYouTube, type FakeYouTube } from '../fixtures/fakeYouTube.js';
import { startSession, queryOffset, uploadFrom, classifyError, UploadError, UploadAbortedError } from '../../src/server/youtube/upload.js';
import { sha256File } from '../../src/server/scan/fingerprint.js';
import { tempDir } from '../fixtures/make-fixtures.js';

let yt: FakeYouTube;
beforeEach(async () => {
  yt = await startFakeYouTube();
});
afterEach(() => yt.close());

const meta = { title: 'Hook title', description: 'Desc', tags: ['Clutch'], categoryId: '20', visibility: 'unlisted' as const, selfDeclaredMadeForKids: false };
const opts = () => ({ baseUrl: yt.baseUrl });

function randomFile(bytes: number): string {
  const f = path.join(tempDir('lt-up-'), 'v.mp4');
  fs.writeFileSync(f, crypto.randomBytes(bytes));
  return f;
}
const noProgress = () => undefined;

describe('startSession', () => {
  it('sends metadata and upload length, returns the session URI', async () => {
    const uri = await startSession('AT', meta, 1234, opts());
    expect(uri).toContain('/upload/session/');
    const s = yt.startRequests[0];
    expect(s.headers.authorization).toBe('Bearer AT');
    expect(s.headers['x-upload-content-length']).toBe('1234');
    expect(s.headers['x-upload-content-type']).toBe('video/mp4');
    expect(s.body).toEqual({
      snippet: { title: 'Hook title', description: 'Desc', tags: ['Clutch'], categoryId: '20' },
      status: { privacyStatus: 'unlisted', selfDeclaredMadeForKids: false },
    });
  });

  it('a quota error is classified as quota, auth as auth, 503+Retry-After as transient with delay', async () => {
    yt.failNextStart = { status: 403, body: { error: { code: 403, message: 'quota', errors: [{ reason: 'quotaExceeded' }] } } };
    await expect(startSession('AT', meta, 10, opts())).rejects.toMatchObject({ kind: 'quota' });
    yt.failNextStart = { status: 401, body: { error: { code: 401, message: 'bad token' } } };
    await expect(startSession('AT', meta, 10, opts())).rejects.toMatchObject({ kind: 'auth' });
    yt.failNextStart = { status: 503, headers: { 'retry-after': '3' } };
    await expect(startSession('AT', meta, 10, opts())).rejects.toMatchObject({ kind: 'transient', retryAfterMs: 3000 });
  });
});

describe('uploadFrom', () => {
  it('uploads in chunks, reports monotonic progress, and the bytes arrive intact', async () => {
    const file = randomFile(1_000_000);
    const uri = await startSession('AT', meta, 1_000_000, opts());
    const seen: number[] = [];
    const r = await uploadFrom(uri, file, 0, (sent) => seen.push(sent), new AbortController().signal, { chunkBytes: 256 * 1024 });
    expect(r.videoId).toBe('vid1');
    expect(yt.videos).toHaveLength(1);
    expect(yt.videos[0].sha256).toBe(await sha256File(file));
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
    expect(seen.at(-1)).toBe(1_000_000);
  });

  it('a drop mid-upload is transient; queryOffset says where to resume; resuming creates exactly one video', async () => {
    const file = randomFile(1_000_000);
    const uri = await startSession('AT', meta, 1_000_000, opts());
    yt.hook = (c) => (c.nth === 2 ? { drop: 'before' } : undefined);
    const err = await uploadFrom(uri, file, 0, noProgress, new AbortController().signal, { chunkBytes: 256 * 1024 }).catch((e) => e);
    expect(err).toBeInstanceOf(UploadError);
    expect(err.kind).toBe('transient');
    const q = await queryOffset(uri, 1_000_000, opts());
    expect(q).toEqual({ state: 'incomplete', nextByte: 256 * 1024 });
    const r = await uploadFrom(uri, file, 256 * 1024, noProgress, new AbortController().signal, { chunkBytes: 256 * 1024 });
    expect(r.videoId).toBe('vid1');
    expect(yt.videos).toHaveLength(1);
    expect(yt.videos[0].sha256).toBe(await sha256File(file));
    expect(yt.sessionsStarted).toBe(1);
  });

  it('review focus 4: a drop on the final chunk is an UNKNOWN outcome, and queryOffset can reconcile it', async () => {
    const file = randomFile(600_000);
    const uri = await startSession('AT', meta, 600_000, opts());
    yt.hook = (c) => (c.isFinal ? { drop: 'after' } : undefined); // server stored it, client never heard
    const err = await uploadFrom(uri, file, 0, noProgress, new AbortController().signal, { chunkBytes: 256 * 1024 }).catch((e) => e);
    expect(err).toBeInstanceOf(UploadError);
    expect(err.kind).toBe('unknown');
    expect(yt.videos).toHaveLength(1);
    expect(await queryOffset(uri, 600_000, opts())).toEqual({ state: 'complete', videoId: 'vid1' });
  });

  it('a drop on the final chunk before the server stored it is also unknown, and reconciles to incomplete', async () => {
    const file = randomFile(600_000);
    const uri = await startSession('AT', meta, 600_000, opts());
    yt.hook = (c) => (c.isFinal ? { drop: 'before' } : undefined);
    const err = await uploadFrom(uri, file, 0, noProgress, new AbortController().signal, { chunkBytes: 256 * 1024 }).catch((e) => e);
    expect(err.kind).toBe('unknown');
    expect(yt.videos).toHaveLength(0);
    expect(await queryOffset(uri, 600_000, opts())).toEqual({ state: 'incomplete', nextByte: 512 * 1024 });
  });

  it('follows a short 308 by resending from where the server says it is', async () => {
    const file = randomFile(600_000);
    const uri = await startSession('AT', meta, 600_000, opts());
    yt.hook = (c) => (c.nth === 1 ? { partial: 100_000 } : undefined);
    const r = await uploadFrom(uri, file, 0, noProgress, new AbortController().signal, { chunkBytes: 256 * 1024 });
    expect(r.videoId).toBe('vid1');
    expect(yt.videos[0].sha256).toBe(await sha256File(file));
  });

  it('an error response mid-upload is classified (quota on a chunk)', async () => {
    const file = randomFile(600_000);
    const uri = await startSession('AT', meta, 600_000, opts());
    yt.hook = (c) => (c.nth === 2 ? { respond: { status: 403, body: { error: { errors: [{ reason: 'uploadLimitExceeded' }], message: 'limit' } } } } : undefined);
    const err = await uploadFrom(uri, file, 0, noProgress, new AbortController().signal, { chunkBytes: 256 * 1024 }).catch((e) => e);
    expect(err.kind).toBe('channel_limit');
  });

  it('aborting stops the upload with UploadAbortedError and leaves the session resumable', async () => {
    const file = randomFile(1_000_000);
    const uri = await startSession('AT', meta, 1_000_000, opts());
    const ac = new AbortController();
    const err = await uploadFrom(uri, file, 0, (sent) => { if (sent >= 256 * 1024) ac.abort(); }, ac.signal, { chunkBytes: 256 * 1024 }).catch((e) => e);
    expect(err).toBeInstanceOf(UploadAbortedError);
    const q = await queryOffset(uri, 1_000_000, opts());
    expect(q.state).toBe('incomplete');
    expect(yt.videos).toHaveLength(0);
  });

  it('queryOffset reports gone for an unknown or expired session', async () => {
    expect(await queryOffset(`${yt.baseUrl}/upload/session/deadbeef`, 100, opts())).toEqual({ state: 'gone' });
  });

  it('streams a 300 MB file with flat memory', async () => {
    const f = path.join(tempDir('lt-big-'), 'big.mp4');
    const fd = fs.openSync(f, 'w');
    fs.ftruncateSync(fd, 300 * 1024 * 1024);
    fs.closeSync(fd);
    const uri = await startSession('AT', meta, 300 * 1024 * 1024, opts());
    const base = process.memoryUsage();
    let peak = 0;
    const t = setInterval(() => {
      const m = process.memoryUsage();
      peak = Math.max(peak, m.heapUsed + m.arrayBuffers - base.heapUsed - base.arrayBuffers);
    }, 10);
    try {
      const r = await uploadFrom(uri, f, 0, noProgress, new AbortController().signal);
      expect(r.videoId).toBe('vid1');
    } finally {
      clearInterval(t);
    }
    // Client and fake server share this process, and peak depends on GC timing (measured 46-103 MB
    // regardless of file size). Buffering the whole file would exceed 300 MB, so half is a safe bound.
    expect(peak).toBeLessThan(150 * 1024 * 1024);
  }, 120000);
});

describe('classifyError', () => {
  const body = (reason: string, message = 'm') => ({ error: { code: 403, message, errors: [{ reason }] } });
  const h = (o: Record<string, string> = {}) => new Headers(o);

  it('maps quota, channel limit, auth, transient and permanent errors', () => {
    expect(classifyError(403, body('quotaExceeded'), h()).kind).toBe('quota');
    expect(classifyError(403, body('dailyLimitExceeded'), h()).kind).toBe('quota');
    expect(classifyError(403, body('uploadLimitExceeded'), h()).kind).toBe('channel_limit');
    expect(classifyError(401, { error: { code: 401, message: 'Invalid Credentials' } }, h()).kind).toBe('auth');
    expect(classifyError(400, { error: 'invalid_grant' }, h()).kind).toBe('auth');
    expect(classifyError(403, body('insufficientPermissions'), h()).kind).toBe('auth');
    for (const s of [408, 429, 500, 502, 503, 504]) expect(classifyError(s, {}, h()).kind, String(s)).toBe('transient');
    expect(classifyError(403, body('rateLimitExceeded'), h()).kind).toBe('transient');
    expect(classifyError(400, body('invalidMetadata'), h()).kind).toBe('permanent');
    expect(classifyError(403, body('forbidden'), h()).kind).toBe('permanent');
    expect(classifyError(404, {}, h()).kind).toBe('permanent');
  });

  it('honours Retry-After in seconds and as an HTTP date', () => {
    expect(classifyError(503, {}, h({ 'retry-after': '7' })).retryAfterMs).toBe(7000);
    const when = new Date(Date.now() + 20_000).toUTCString();
    const ms = classifyError(429, {}, h({ 'retry-after': when })).retryAfterMs!;
    expect(ms).toBeGreaterThan(15_000);
    expect(ms).toBeLessThanOrEqual(20_000);
    expect(classifyError(503, {}, h()).retryAfterMs).toBeUndefined();
  });

  it('includes a short, token-free message', () => {
    const r = classifyError(403, body('quotaExceeded', 'The request cannot be completed because you have exceeded your quota.'), h());
    expect(r.message).toMatch(/quota/i);
    expect(r.message.length).toBeLessThan(300);
  });
});
