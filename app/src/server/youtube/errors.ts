export type ErrorKind = 'transient' | 'quota' | 'channel_limit' | 'auth' | 'permanent' | 'unknown';

export interface Classified {
  kind: ErrorKind;
  retryAfterMs?: number;
  message: string;
}

/** An upload-related failure with a machine-readable category. */
export class UploadError extends Error {
  constructor(
    message: string,
    public readonly kind: ErrorKind,
    public readonly retryAfterMs?: number,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

/** The caller aborted (pause, shutdown). The resumable session is still valid. */
export class UploadAbortedError extends Error {
  constructor() {
    super('upload aborted');
    this.name = 'UploadAbortedError';
  }
}

const QUOTA = new Set(['quotaExceeded', 'dailyLimitExceeded']);
const CHANNEL_LIMIT = new Set(['uploadLimitExceeded']);
const AUTH_REASONS = new Set(['authError', 'insufficientPermissions', 'youtubeSignupRequired']);
const TRANSIENT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'backendError', 'internalError']);

function retryAfter(headers: Headers): number | undefined {
  const v = headers.get('retry-after');
  if (!v) return undefined;
  if (/^\d+$/.test(v.trim())) return Number(v) * 1000;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : Math.max(0, t - Date.now());
}

/** Maps a YouTube / Google API HTTP error to a category that decides what the queue does next. */
export function classifyError(status: number, body: unknown, headers: Headers): Classified {
  const b = (body ?? {}) as { error?: unknown };
  const errObj = typeof b.error === 'object' && b.error ? (b.error as { message?: string; errors?: { reason?: string }[] }) : undefined;
  const errString = typeof b.error === 'string' ? b.error : undefined;
  const reasons = (errObj?.errors ?? []).map((e) => e.reason ?? '').filter(Boolean);
  const message = (errObj?.message ?? errString ?? `HTTP ${status}`).slice(0, 200);
  const retryAfterMs = retryAfter(headers);
  const done = (kind: ErrorKind): Classified => ({ kind, message, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });

  if (reasons.some((r) => QUOTA.has(r))) return done('quota');
  if (reasons.some((r) => CHANNEL_LIMIT.has(r))) return done('channel_limit');
  if (status === 401 || errString === 'invalid_grant' || errString === 'invalid_token' || reasons.some((r) => AUTH_REASONS.has(r))) return done('auth');
  if (reasons.some((r) => TRANSIENT_REASONS.has(r))) return done('transient');
  if (status === 408 || status === 429 || status >= 500) return done('transient');
  if (status >= 400) return done('permanent');
  return done('unknown');
}
