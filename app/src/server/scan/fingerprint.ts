import crypto from 'node:crypto';
import fs from 'node:fs';
import type { Db } from '../db/db.js';

/** Streaming SHA-256: memory use does not scale with file size. */
export async function sha256File(file: string): Promise<string> {
  const h = crypto.createHash('sha256');
  const buf = Buffer.allocUnsafe(1024 * 1024); // one reused buffer: constant memory
  const fh = await fs.promises.open(file, 'r');
  try {
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      h.update(buf.subarray(0, bytesRead));
    }
  } finally {
    await fh.close();
  }
  return h.digest('hex');
}

/**
 * Hashes a video and stores the digest. Throws if the file no longer matches the
 * size/mtime recorded at discovery (or changes while being hashed), so a stale
 * fingerprint can never be associated with different bytes.
 */
export async function fingerprintVideo(db: Db, videoId: number): Promise<string> {
  const row = db.prepare('SELECT file_path, file_size_bytes, modified_at FROM videos WHERE id = ?').get(videoId) as
    | { file_path: string; file_size_bytes: number; modified_at: number }
    | undefined;
  if (!row) throw new Error(`video ${videoId} not found`);
  const before = await fs.promises.stat(row.file_path);
  if (before.size !== row.file_size_bytes || Math.trunc(before.mtimeMs) !== row.modified_at) {
    throw new Error('file changed since it was discovered; rescan before fingerprinting');
  }
  const hash = await sha256File(row.file_path);
  const after = await fs.promises.stat(row.file_path);
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('file changed while hashing');
  db.prepare("UPDATE videos SET content_hash = ?, updated_at = datetime('now') WHERE id = ?").run(hash, videoId);
  return hash;
}
