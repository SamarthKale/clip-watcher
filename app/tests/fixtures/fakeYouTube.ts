import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type ChunkAction =
  | undefined
  /** Drop the connection before ('before': nothing stored) or after ('after': stored, no response) handling the chunk. */
  | { drop: 'before' | 'after' }
  /** Respond with an error without storing the chunk. */
  | { respond: { status: number; body?: unknown; headers?: Record<string, string> } }
  /** Accept only this many bytes of the chunk (a short 308). */
  | { partial: number };

export interface ChunkCtx {
  sessionId: string;
  start: number;
  end: number;
  total: number;
  isFinal: boolean;
  /** 1-based count of data requests seen across all sessions. */
  nth: number;
}

export interface FakeVideo {
  id: string;
  meta: any;
  bytes: number;
  sha256: string;
}

export interface FakeYouTube {
  baseUrl: string;
  sessionsStarted: number;
  videos: FakeVideo[];
  sessions: Map<string, { meta: any; size: number; received: number; hash: crypto.Hash; videoId?: string }>;
  startRequests: { headers: http.IncomingHttpHeaders; body: any }[];
  /** Respond to the next session-start request with this error. */
  failNextStart?: { status: number; body?: unknown; headers?: Record<string, string> };
  /** Fail the nth (1-based) session-start request once. */
  failStartNth?: { n: number; status: number; body?: unknown; headers?: Record<string, string> };
  /** Fail every session-start request. */
  failStartAlways?: { status: number; body?: unknown; headers?: Record<string, string> };
  /** Highest number of data (chunk) requests in flight at the same time. */
  maxActiveData: number;
  /** Called for every data request; may inject faults. */
  hook?: (ctx: ChunkCtx) => ChunkAction;
  /** videos.list status the monitor sees, by video id. */
  statusOf: (id: string) => { uploadStatus?: string; privacyStatus?: string; processingStatus?: string; failureReason?: string; rejectionReason?: string } | null;
  statusRequests: string[];
  close(): Promise<void>;
}

export async function startFakeYouTube(): Promise<FakeYouTube> {
  let nth = 0;
  let activeData = 0;
  const fake: FakeYouTube = {
    baseUrl: '',
    sessionsStarted: 0,
    videos: [],
    sessions: new Map(),
    startRequests: [],
    statusOf: () => ({ uploadStatus: 'processed', privacyStatus: 'public', processingStatus: 'succeeded' }),
    statusRequests: [],
    maxActiveData: 0,
    close: async () => undefined,
  };

  const json = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    res.end(JSON.stringify(body ?? {}));
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');

    if (req.method === 'POST' && url.pathname === '/upload/youtube/v3/videos') {
      let raw = '';
      req.on('data', (d) => (raw += d));
      req.on('end', () => {
        if (!req.headers.authorization?.startsWith('Bearer ')) return json(res, 401, { error: { code: 401, message: 'Login Required' } });
        const body = raw ? JSON.parse(raw) : {};
        fake.startRequests.push({ headers: req.headers, body });
        const startNo = fake.startRequests.length;
        if (fake.failStartAlways) {
          const f = fake.failStartAlways;
          return json(res, f.status, f.body ?? {}, f.headers);
        }
        if (fake.failStartNth && fake.failStartNth.n === startNo) {
          const f = fake.failStartNth;
          fake.failStartNth = undefined;
          return json(res, f.status, f.body ?? {}, f.headers);
        }
        if (fake.failNextStart) {
          const f = fake.failNextStart;
          fake.failNextStart = undefined;
          return json(res, f.status, f.body ?? {}, f.headers);
        }
        const sid = crypto.randomBytes(8).toString('hex');
        fake.sessionsStarted++;
        fake.sessions.set(sid, { meta: body, size: Number(req.headers['x-upload-content-length'] ?? 0), received: 0, hash: crypto.createHash('sha256') });
        res.statusCode = 200;
        res.setHeader('location', `${fake.baseUrl}/upload/session/${sid}`);
        res.end();
      });
      return;
    }

    const m = url.pathname.match(/^\/upload\/session\/(\w+)$/);
    if (req.method === 'PUT' && m) {
      const sid = m[1];
      const s = fake.sessions.get(sid);
      const range = String(req.headers['content-range'] ?? '');
      if (!s) {
        req.resume();
        return json(res, 404, { error: { code: 404, message: 'Not Found' } });
      }
      const reply308 = () => {
        res.statusCode = 308;
        if (s.received > 0) res.setHeader('range', `bytes=0-${s.received - 1}`);
        res.end();
      };
      const complete = () => json(res, 200, { id: s.videoId, kind: 'youtube#video', status: { uploadStatus: 'uploaded' } });

      if (range.startsWith('bytes */')) {
        req.resume();
        return s.videoId ? complete() : reply308();
      }
      const rm = range.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
      if (!rm) {
        req.resume();
        return json(res, 400, { error: { code: 400, message: 'bad content-range' } });
      }
      const start = Number(rm[1]);
      const end = Number(rm[2]);
      const total = Number(rm[3]);
      activeData++;
      fake.maxActiveData = Math.max(fake.maxActiveData, activeData);
      res.on('close', () => activeData--);
      const ctx: ChunkCtx = { sessionId: sid, start, end, total, isFinal: end + 1 === total, nth: ++nth };
      const action = fake.hook?.(ctx);

      if (action && 'drop' in action && action.drop === 'before') {
        req.destroy();
        return;
      }
      if (action && 'respond' in action) {
        req.resume();
        return json(res, action.respond.status, action.respond.body ?? {}, action.respond.headers);
      }
      if (start !== s.received) {
        req.resume();
        return reply308(); // out-of-order: tell the client where we are
      }
      const limit = action && 'partial' in action ? action.partial : Infinity;
      let taken = 0;
      req.on('data', (d: Buffer) => {
        const room = Math.max(0, limit - taken);
        const part = room >= d.length ? d : d.subarray(0, room);
        taken += part.length;
        s.hash.update(part);
        s.received += part.length;
      });
      req.on('end', () => {
        if (s.received >= s.size && !s.videoId) {
          s.videoId = `vid${fake.videos.length + 1}`;
          fake.videos.push({ id: s.videoId, meta: s.meta, bytes: s.received, sha256: s.hash.digest('hex') });
        }
        if (action && 'drop' in action && action.drop === 'after') {
          res.destroy();
          return;
        }
        s.videoId ? complete() : reply308();
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/youtube/v3/videos') {
      const ids = (url.searchParams.get('id') ?? '').split(',').filter(Boolean);
      fake.statusRequests.push(url.searchParams.get('id') ?? '');
      if (!req.headers.authorization?.startsWith('Bearer ')) return json(res, 401, { error: { code: 401, message: 'Login Required' } });
      const items = ids.flatMap((id) => {
        const st = fake.statusOf(id);
        return st
          ? [{ id, status: { uploadStatus: st.uploadStatus, privacyStatus: st.privacyStatus, failureReason: st.failureReason, rejectionReason: st.rejectionReason }, processingDetails: { processingStatus: st.processingStatus } }]
          : [];
      });
      return json(res, 200, { items });
    }

    res.statusCode = 404;
    res.end();
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  fake.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () =>
    new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
  return fake;
}
