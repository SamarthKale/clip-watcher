import path from 'node:path';
import fs from 'node:fs';

/** Path of the app data directory without creating it. */
export function dataDirPath(): string {
  return process.env.LOCALTUBE_DATA ?? path.join(process.cwd(), 'data');
}

export function dataDir(): string {
  const dir = dataDirPath();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
export const PORT = Number(process.env.PORT ?? 4317);
