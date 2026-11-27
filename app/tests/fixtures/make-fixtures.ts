import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface FixtureOpts {
  width?: number;
  height?: number;
  seconds?: number;
  /** Changes the bytes without changing the picture, so two fixtures can differ. */
  seed?: string;
  audio?: boolean;
  /** Target video bitrate, e.g. '4M', to make larger files. */
  bitrate?: string;
  /** High-entropy picture so the file is large (several MB) even for a few seconds. */
  noisy?: boolean;
}

/** Generates a tiny real MP4 with ffmpeg at `dest`. */
export function makeFixtureMp4(dest: string, o: FixtureOpts = {}): string {
  const { width = 270, height = 480, seconds = 1, seed = 'a', audio = true, bitrate, noisy } = o;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const src = noisy
    ? `color=c=black:size=${width}x${height}:rate=30:duration=${seconds},noise=alls=100:allf=t+u`
    : `testsrc=size=${width}x${height}:rate=30:duration=${seconds}`;
  const args = ['-y', '-v', 'error', '-f', 'lavfi', '-i', src];
  if (audio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`);
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p');
  if (bitrate) args.push('-b:v', bitrate, '-maxrate', bitrate, '-bufsize', bitrate);
  if (audio) args.push('-c:a', 'aac', '-shortest');
  args.push('-metadata', `comment=${seed}`, dest);
  execFileSync(process.env.FFMPEG_PATH ?? 'ffmpeg', args);
  return dest;
}

const cache = new Map<string, string>();

/** Returns a cached fixture path (generated once per test run). Copy it before mutating. */
export function fixture(name: 'short' | 'landscape' | 'other'): string {
  const hit = cache.get(name);
  if (hit && fs.existsSync(hit)) return hit;
  const dir = path.join(os.tmpdir(), 'localtube-fixtures');
  const dest = path.join(dir, `${name}.mp4`);
  if (!fs.existsSync(dest)) {
    if (name === 'landscape') makeFixtureMp4(dest, { width: 480, height: 270, seed: 'l' });
    else if (name === 'other') makeFixtureMp4(dest, { seed: 'other' });
    else makeFixtureMp4(dest);
  }
  cache.set(name, dest);
  return dest;
}

export function tempDir(prefix = 'lt-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
