import { execFile } from 'node:child_process';

/** Current YouTube Shorts maximum length in seconds. Verify against official docs (Phase 0). */
export const SHORTS_MAX_SECONDS = 180;

export interface ProbeResult {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  videoCodec: string;
  audioCodec: string | null;
  shortsWarning: string | null;
}

export type ProbeFn = (file: string) => Promise<ProbeResult>;

interface FfprobeJson {
  streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; avg_frame_rate?: string; r_frame_rate?: string }[];
  format?: { format_name?: string; duration?: string };
}

function parseRate(r: string | undefined): number {
  if (!r) return 0;
  const [n, d] = r.split('/').map(Number);
  return d ? n / d : n || 0;
}

export function ffprobePath(): string {
  return process.env.FFPROBE_PATH ?? 'ffprobe';
}

export const probeVideo: ProbeFn = (file) =>
  new Promise((resolve, reject) => {
    execFile(
      ffprobePath(),
      ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file],
      { maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(new Error(`ffprobe failed: ${err.message}`));
        let j: FfprobeJson;
        try {
          j = JSON.parse(stdout) as FfprobeJson;
        } catch {
          return reject(new Error('ffprobe returned invalid JSON'));
        }
        const v = j.streams?.find((s) => s.codec_type === 'video');
        const a = j.streams?.find((s) => s.codec_type === 'audio');
        if (!v || !v.width || !v.height) return reject(new Error('no video stream'));
        if (!j.format?.format_name?.includes('mp4')) return reject(new Error(`not an MP4 container (${j.format?.format_name})`));
        const durationSec = Number(j.format.duration ?? 0);
        const warnings: string[] = [];
        if (v.height < v.width) warnings.push('Video is landscape; Shorts must be vertical or square');
        if (durationSec > SHORTS_MAX_SECONDS) warnings.push(`Longer than ${SHORTS_MAX_SECONDS}s; may not qualify as a Short`);
        resolve({
          durationSec,
          width: v.width,
          height: v.height,
          fps: parseRate(v.avg_frame_rate || v.r_frame_rate),
          videoCodec: v.codec_name ?? 'unknown',
          audioCodec: a?.codec_name ?? null,
          shortsWarning: warnings.length ? warnings.join('; ') : null,
        });
      },
    );
  });
