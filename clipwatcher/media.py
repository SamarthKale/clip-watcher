"""Thin wrappers around ffmpeg / ffprobe."""
from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path


class MediaError(RuntimeError):
    pass


def run(cmd: list[str], timeout: float | None = None) -> subprocess.CompletedProcess:
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                          errors="replace", timeout=timeout)
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "")[-2000:]
        raise MediaError(f"{Path(cmd[0]).name} exited {proc.returncode}: {tail}")
    return proc


def probe(ffprobe: str, path: Path) -> dict:
    out = run([ffprobe, "-v", "error", "-print_format", "json", "-show_format",
               "-show_streams", str(path)], timeout=120).stdout
    return json.loads(out)


def duration(ffprobe: str, path: Path) -> float:
    info = probe(ffprobe, path)
    d = info.get("format", {}).get("duration")
    if d is None:
        ds = [float(s["duration"]) for s in info.get("streams", []) if s.get("duration")]
        if not ds:
            raise MediaError(f"could not read duration of {path}")
        return max(ds)
    return float(d)


def summarize(info: dict) -> dict:
    """Compact stream description stored in clip metadata."""
    out: dict = {"duration": float(info.get("format", {}).get("duration") or 0)}
    for s in info.get("streams", []):
        if s.get("codec_type") == "video" and "video" not in out:
            out["video"] = {"codec": s.get("codec_name"), "width": s.get("width"),
                            "height": s.get("height"), "fps": s.get("avg_frame_rate"),
                            "pix_fmt": s.get("pix_fmt"), "profile": s.get("profile"),
                            "bit_rate": int(s["bit_rate"]) if str(s.get("bit_rate", "")).isdigit() else None}
        elif s.get("codec_type") == "audio" and "audio" not in out:
            out["audio"] = {"codec": s.get("codec_name"), "sample_rate": s.get("sample_rate"),
                            "channels": s.get("channels"),
                            "bit_rate": int(s["bit_rate"]) if str(s.get("bit_rate", "")).isdigit() else None}
    return out


def verify_playable(ffmpeg: str, ffprobe: str, path: Path, full_decode: bool = True,
                    need_audio: bool = True) -> dict:
    """Check a media file is complete and playable. Raises MediaError if not.

    Probes the streams and (by default) decodes every frame, so truncated or
    corrupt files are caught - not just files with a valid header.
    """
    if not path.exists() or path.stat().st_size == 0:
        raise MediaError(f"{path} is missing or empty")
    info = summarize(probe(ffprobe, path))
    if not info.get("video"):
        raise MediaError(f"{path} has no video stream")
    if need_audio and not info.get("audio"):
        raise MediaError(f"{path} has no audio stream")
    if info.get("duration", 0) <= 0:
        raise MediaError(f"{path} has no duration")
    if full_decode:
        proc = subprocess.run([ffmpeg, "-hide_banner", "-nostdin", "-v", "error", "-i", str(path),
                               "-f", "null", "-"], capture_output=True, text=True, encoding="utf-8",
                              errors="replace", timeout=1800)
        errors = [ln for ln in (proc.stderr or "").splitlines() if ln.strip()]
        if proc.returncode != 0 or len(errors) > 5:
            raise MediaError(f"{path} failed to decode cleanly: {' | '.join(errors[:5])}")
        info["decode_warnings"] = len(errors)
    info["bytes"] = path.stat().st_size
    return info


def loudness(ffmpeg: str, path: Path) -> dict:
    proc = subprocess.run([ffmpeg, "-hide_banner", "-nostdin", "-i", str(path), "-af",
                           "ebur128=peak=true", "-f", "null", "-"], capture_output=True, text=True,
                          encoding="utf-8", errors="replace", timeout=600)
    text = proc.stderr or ""
    out = {}
    for key, pat in (("lufs", r"I:\s+(-?[\d.]+) LUFS"), ("true_peak_db", r"Peak:\s+(-?[\d.]+) dBFS"),
                     ("lra", r"LRA:\s+(-?[\d.]+) LU")):
        found = re.findall(pat, text)
        if found:
            out[key] = float(found[-1])
    return out


def fps_value(rate: str | None) -> float:
    """'30000/1001' -> 29.97"""
    try:
        n, _, d = str(rate or "0").partition("/")
        return float(n) / float(d or 1) if float(d or 1) else 0.0
    except ValueError:
        return 0.0


_BLACK = re.compile(r"black_start:\s*([\d.]+)\s+black_end:\s*([\d.]+)")
_FREEZE_START = re.compile(r"freeze_start:\s*([\d.]+)")
_FREEZE_END = re.compile(r"freeze_end:\s*([\d.]+)")
_SIL_START = re.compile(r"silence_start:\s*(-?[\d.]+)")
_SIL_END = re.compile(r"silence_end:\s*([\d.]+)")


def _spans(text: str, start_re: re.Pattern, end_re: re.Pattern, total: float) -> list[list[float]]:
    out, cur = [], None
    for line in text.splitlines():
        if (m := start_re.search(line)):
            cur = max(0.0, float(m.group(1)))
        elif (m := end_re.search(line)) and cur is not None:
            out.append([round(cur, 2), round(float(m.group(1)), 2)])
            cur = None
    if cur is not None:
        out.append([round(cur, 2), round(total, 2)])
    return out


def qa_scan(ffmpeg: str, path: Path, total: float) -> dict:
    """One decode pass over a finished render: black frames, frozen picture, silent
    stretches and loudness (integrated LUFS, true peak, LRA)."""
    proc = subprocess.run([ffmpeg, "-hide_banner", "-nostdin", "-i", str(path),
                           "-vf", "blackdetect=d=0.1:pix_th=0.10,freezedetect=n=-60dB:d=0.6",
                           "-af", "silencedetect=noise=-50dB:d=1.0,ebur128=peak=true",
                           "-f", "null", "-"], capture_output=True, text=True, encoding="utf-8",
                          errors="replace", timeout=1800)
    text = proc.stderr or ""
    if proc.returncode != 0:
        raise MediaError(f"QA scan of {path} failed: {text[-800:]}")
    out: dict = {
        "black": [[round(float(a), 2), round(float(b), 2)] for a, b in _BLACK.findall(text)],
        "frozen": _spans(text, _FREEZE_START, _FREEZE_END, total),
        "silent": _spans(text, _SIL_START, _SIL_END, total),
    }
    for key, pat in (("lufs", r"I:\s+(-?[\d.]+) LUFS"), ("true_peak_db", r"Peak:\s+(-?[\d.]+) dBFS"),
                     ("lra", r"LRA:\s+(-?[\d.]+) LU")):
        found = re.findall(pat, text)
        if found:
            out[key] = float(found[-1])
    return out


def keyframe_at_or_before(ffprobe: str, path: Path, t: float, search: float = 12.0) -> float:
    """Time (seconds from the start of `path`) of the last video keyframe <= t.

    Stream-copy cuts must start on a keyframe: starting between keyframes makes
    the video begin at the *next* keyframe while the audio begins at t, leaving
    a stretch of audio with no picture at the head of the clip.
    """
    fmt = json.loads(run([ffprobe, "-v", "error", "-print_format", "json", "-show_entries",
                          "format=start_time", str(path)], timeout=60).stdout)
    origin = float(fmt.get("format", {}).get("start_time") or 0)
    lo = max(0.0, t - search)
    out = run([ffprobe, "-v", "error", "-select_streams", "v:0", "-skip_frame", "nokey",
               "-show_entries", "frame=pts_time", "-of", "csv=p=0",
               "-read_intervals", f"{origin + lo:.3f}%+{search + 1:.3f}", str(path)],
              timeout=120).stdout
    keys = []
    for line in out.split():
        try:
            keys.append(float(line.strip().strip(",")) - origin)
        except ValueError:
            pass
    before = [k for k in keys if k <= t + 1e-3]
    if before:
        return max(0.0, max(before))
    if t <= search:
        return 0.0
    raise MediaError(f"no keyframe found in {path} between {lo:.1f}s and {t:.1f}s")


def cut_copy_cmd(ffmpeg: str, src: Path, start: float, length: float, dst: Path) -> list[str]:
    """The original STEP 4 command: ffmpeg -ss START -i stream.ts -t DURATION -c copy clip.mp4

    Stream copy = no re-encode, original quality and audio. START should be a
    keyframe time (see keyframe_at_or_before) so audio and video begin together.
    """
    return [ffmpeg, "-hide_banner", "-nostdin", "-y",
            "-ss", f"{start:.3f}", "-i", str(src), "-t", f"{length:.3f}",
            "-map", "0:v:0?", "-map", "0:a?", "-c", "copy",
            "-avoid_negative_ts", "make_zero", "-movflags", "+faststart",
            str(dst)]


def frames_cmd(ffmpeg: str, src: Path, every: float, width: int, pattern: Path) -> list[str]:
    return [ffmpeg, "-hide_banner", "-nostdin", "-y", "-i", str(src),
            "-vf", f"fps=1/{every},scale={width}:-2", "-q:v", "3", str(pattern)]


def frame_at_cmd(ffmpeg: str, src: Path, t: float, width: int, dst: Path) -> list[str]:
    return [ffmpeg, "-hide_banner", "-nostdin", "-y", "-ss", f"{t:.3f}", "-i", str(src),
            "-frames:v", "1", "-vf", f"scale={width}:-2", "-q:v", "3", str(dst)]


def wav_cmd(ffmpeg: str, src: Path, dst: Path) -> list[str]:
    """16 kHz mono PCM - the input format whisper.cpp expects."""
    return [ffmpeg, "-hide_banner", "-nostdin", "-y", "-i", str(src),
            "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(dst)]
