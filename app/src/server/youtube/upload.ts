import fs from 'node:fs';
import type { Visibility } from '../types.js';
import { classifyError, UploadAbortedError, UploadError } from './errors.js';

export { classifyError, UploadAbortedError, UploadError } from './errors.js';

const DEFAULT_BASE = 'https://www.googleapis.com';
/** Must be a multiple of 256 KiB (resumable upload protocol). */
const DEFAULT_CHUNK = 8 * 1024 * 1024;

export interface UploadOpts {
  baseUrl?: string;
  chunkBytes?: number;
}

export interface SessionMeta {
  title: string;
  description: string;
  tags: string[];
  categoryId: string;
  visibility: Visibility;
  selfDeclaredMadeForKids: boolean;
  notifySubscribers?: boolean;
}

export type OffsetState = { state: 'incomplete'; nextByte: number } | { state: 'complete'; videoId: string } | { state: 'gone' };

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => '');
  try {
    return JSON.parse(text);
  } catch {
    return { error: { message: text.slice(0, 200) } };
  }
}

async function failure(res: Response): Promise<UploadError> {
  const c = classifyError(res.status, await readBody(res), res.headers);
  return new UploadError(c.message, c.kind, c.retryAfterMs, res.status);
}

function networkError(e: unknown, kind: 'transient' | 'unknown'): UploadError {
  return new UploadError(`network error: ${e instanceof Error ? e.message : String(e)}`, kind);
}

function nextByteFrom(res: Response): number {
  const m = res.headers.get('range')?.match(/bytes=0-(\d+)/);
  return m ? Number(m[1]) + 1 : 0;
}

/** Creates a resumable upload session. No video exists until the bytes are sent, so this is safe to retry. */
export async function startSession(accessToken: string, meta: SessionMeta, fileSize: number, opts: UploadOpts = {}): Promise<string> {
  const base = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/$/, '');
  const qs = new URLSearchParams({ uploadType: 'resumable', part: 'snippet,status' });
  if (meta.notifySubscribers !== undefined) qs.set('notifySubscribers', String(meta.notifySubscribers));
  let res: Response;
  try {
    res = await fetch(`${base}/upload/youtube/v3/videos?${qs}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json; charset=UTF-8',
        'x-upload-content-length': String(fileSize),
        'x-upload-content-type': 'video/mp4',
      },
      body: JSON.stringify({
        snippet: { title: meta.title, description: meta.description, tags: meta.tags, categoryId: meta.categoryId },
        status: { privacyStatus: meta.visibility, selfDeclaredMadeForKids: meta.selfDeclaredMadeForKids },
      }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    throw networkError(e, 'transient');
  }
  if (!res.ok) throw await failure(res);
  const loc = res.headers.get('location');
  if (!loc) throw new UploadError('YouTube did not return an upload session URL', 'unknown');
  return loc;
}

/** Asks YouTube how much of the session it has, without sending data. */
export async function queryOffset(sessionUri: string, fileSize: number, _opts: UploadOpts = {}): Promise<OffsetState> {
  let res: Response;
  try {
    res = await fetch(sessionUri, {
      method: 'PUT',
      headers: { 'content-range': `bytes */${fileSize}` },
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw networkError(e, 'transient');
  }
  if (res.status === 308) return { state: 'incomplete', nextByte: nextByteFrom(res) };
  if (res.status === 200 || res.status === 201) {
    const j = (await readBody(res)) as { id?: string };
    if (!j.id) throw new UploadError('YouTube reported the upload complete without a video id', 'unknown');
    return { state: 'complete', videoId: j.id };
  }
  if (res.status === 404 || res.status === 410) return { state: 'gone' };
  throw await failure(res);
}

/**
 * Streams the file from `startByte` in chunks, one reused buffer, so memory does not grow with
 * file size. A network failure on the final chunk is `unknown` (YouTube may have stored it);
 * on any other chunk it is `transient` and the caller resumes via queryOffset.
 */
export async function uploadFrom(
  sessionUri: string,
  file: string,
  startByte: number,
  onProgress: (sent: number, total: number) => void,
  signal: AbortSignal,
  opts: UploadOpts = {},
): Promise<{ videoId: string }> {
  const total = (await fs.promises.stat(file)).size;
  const chunk = opts.chunkBytes ?? DEFAULT_CHUNK;
  const buf = Buffer.allocUnsafe(Math.min(chunk, Math.max(total, 1)));
  const fh = await fs.promises.open(file, 'r');
  try {
    let offset = startByte;
    for (;;) {
      if (signal.aborted) throw new UploadAbortedError();
      if (offset >= total) throw new UploadError('server confirmed all bytes but returned no video', 'unknown');
      const len = Math.min(chunk, total - offset);
      let filled = 0;
      while (filled < len) {
        const { bytesRead } = await fh.read(buf, filled, len - filled, offset + filled);
        if (bytesRead === 0) throw new UploadError('source file shrank while uploading', 'permanent');
        filled += bytesRead;
      }
      const isFinal = offset + len === total;

      let res: Response;
      try {
        res = await fetch(sessionUri, {
          method: 'PUT',
          headers: { 'content-range': `bytes ${offset}-${offset + len - 1}/${total}`, 'content-type': 'video/mp4' },
          body: buf.subarray(0, len),
          redirect: 'manual',
          signal,
        });
      } catch (e) {
        if (signal.aborted) throw new UploadAbortedError();
        throw networkError(e, isFinal ? 'unknown' : 'transient');
      }

      if (res.status === 308) {
        await res.arrayBuffer().catch(() => undefined);
        offset = nextByteFrom(res);
        onProgress(offset, total);
        continue;
      }
      if (res.status === 200 || res.status === 201) {
        const j = (await readBody(res)) as { id?: string };
        if (!j.id) throw new UploadError('YouTube returned no video id', 'unknown');
        onProgress(total, total);
        return { videoId: j.id };
      }
      throw await failure(res);
    }
  } finally {
    await fh.close();
  }
}
