export const MAX_ATTEMPTS = 6;
const BACKOFF_CAP_MS = 30 * 60_000;

/**
 * Exponential backoff with +/-25% jitter: base, 2x, 4x ... capped at 30 minutes. A server-supplied
 * Retry-After wins when it asks for longer. `attempt` is 1-based.
 */
export function nextRetryDelayMs(attempt: number, rand: () => number = Math.random, retryAfterMs?: number, baseMs = 30_000): number {
  const raw = Math.min(baseMs * 2 ** (attempt - 1), BACKOFF_CAP_MS);
  const delay = Math.round(raw * (0.75 + rand() * 0.5));
  return retryAfterMs !== undefined && retryAfterMs > delay ? retryAfterMs : delay;
}

/**
 * When the YouTube Data API daily quota is expected to reset: midnight Pacific time. This is a local
 * estimate based on Google's documentation (verify in Phase 0), not a guarantee. The 5 minute margin
 * avoids retrying right at the boundary.
 */
export function nextQuotaResetMs(now: number, marginMs = 5 * 60_000): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hourCycle: 'h23',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(now));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const sinceMidnightMs = ((get('hour') * 60 + get('minute')) * 60 + get('second')) * 1000 + (((now % 1000) + 1000) % 1000);
  return now - sinceMidnightMs + 24 * 3600_000 + marginMs;
}
