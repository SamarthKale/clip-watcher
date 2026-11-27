import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { FRAMES_MAX, FRAME_MAX_SIDE_PX } from '../ai/limits.js';

const MIN_FREE_BYTES = 200 * 1024 * 1024;

export function ffmpegPath(): string {
  return process.env.FFMPEG_PATH ?? 'ffmpeg';
}

function extractOne(file: string, atSec: number, out: string): Promise<void> {
  const scale = `scale='min(${FRAME_MAX_SIDE_PX},iw)':'min(${FRAME_MAX_SIDE_PX},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`;
  return new Promise((resolve, reject) => {
    execFile(
      ffmpegPath(),
      ['-v', 'error', '-ss', atSec.toFixed(3), '-i', file, '-frames:v', '1', '-vf', scale, '-q:v', '4', '-y', out],
      (err) => (err ? reject(new Error(`ffmpeg frame extraction failed: ${err.message}`)) : resolve()),
    );
  });
}

/**
 * Extracts up to FRAMES_MAX JPEG frames spread evenly across the video (never only the first
 * seconds). Files are written only inside `outDir`; the source file is opened read-only by ffmpeg.
 */
export async function extractFrames(file: string, durationSec: number, count: number, outDir: string): Promise<string[]> {
  const n = Math.max(1, Math.min(FRAMES_MAX, Math.floor(count)));
  fs.mkdirSync(outDir, { recursive: true });
  try {
    const st = await fs.promises.statfs(outDir);
    if (st.bavail * st.bsize < MIN_FREE_BYTES) throw new Error('not enough free disk space for temporary frames');
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('not enough')) throw e; // statfs unavailable: skip the check
  }
  const dur = durationSec > 0 ? durationSec : 1;
  const jobs = Array.from({ length: n }, (_, i) => ({
    at: Math.min(dur * ((i + 0.5) / n), Math.max(dur - 0.05, 0)),
    out: path.join(outDir, `frame-${String(i).padStart(2, '0')}.jpg`),
  }));
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, jobs.length) }, async () => {
      while (next < jobs.length) {
        const j = jobs[next++];
        await extractOne(file, j.at, j.out);
      }
    }),
  );
  return jobs.map((j) => j.out);
}
