import fs from 'node:fs';
import path from 'node:path';

const SECRET_KEY = /^(access_token|refresh_token|authorization|apikey|api_key|client_secret|x-goog-api-key)$/i;
const MAX_BYTES = 5 * 1024 * 1024;

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SECRET_KEY.test(k) ? '[REDACTED]' : redact(v)]),
    );
  }
  return value;
}

let logFile: string | null = null;
export function setLogDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  logFile = path.join(dir, 'localtube.log');
}

function write(level: string, msg: string, ctx?: unknown): void {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ctx: redact(ctx) }) + '\n';
  if (!logFile) {
    if (!process.env.VITEST) process.stderr.write(line);
    return;
  }
  try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > MAX_BYTES) fs.renameSync(logFile, logFile + '.1');
    fs.appendFileSync(logFile, line);
  } catch {
    /* logging must never crash the app */
  }
}

export const log = {
  info: (m: string, c?: unknown) => write('info', m, c),
  warn: (m: string, c?: unknown) => write('warn', m, c),
  error: (m: string, c?: unknown) => write('error', m, c),
};
