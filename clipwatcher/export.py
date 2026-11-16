"""Platform exports for a finished Short: YouTube Shorts, TikTok, Instagram Reels.

Quality first, then storage: the master `short.mp4` is reused as-is for every
platform whose spec it already meets (no copy, no re-encode, no generation
loss). Only what is out of spec is fixed, as gently as possible:

  audio bitrate too high  -> copy the video, re-encode only the audio
  video bitrate / size    -> re-encode the video once, capped (CRF 18, slow preset)
  frame rate too high     -> re-encode at the platform's maximum
  too long                -> not exported (a re-edit is needed; never auto-trimmed)

Results go to <Short>/final/: platform files (only when they differ from the
master), manifest.json and UPLOAD.txt (which file to upload where). Nothing is
uploaded. Specs are conservative upload limits; override any value in
config.toml under [export.specs.<platform>].
"""
from __future__ import annotations

import copy
import json
import os
import time
from pathlib import Path

from . import media
from .util import utc_iso, write_json

SPECS: dict[str, dict] = {
    "youtube_shorts": {"label": "YouTube Shorts", "file": "youtube_shorts.mp4", "max_seconds": 180,
                       "max_fps": 60, "max_video_mbps": None, "max_audio_kbps": None, "max_mb": None},
    "tiktok": {"label": "TikTok", "file": "tiktok.mp4", "max_seconds": 600, "max_fps": 60,
               "max_video_mbps": None, "max_audio_kbps": None, "max_mb": 287},
    "instagram_reels": {"label": "Instagram Reels", "file": "instagram_reels.mp4", "max_seconds": 180,
                        "max_fps": 60, "max_video_mbps": 25, "max_audio_kbps": 128, "max_mb": 300},
}
COMMON = {"width": 1080, "height": 1920, "codec": "h264", "pix_fmt": "yuv420p", "audio_codec": "aac"}


def specs(cfg) -> dict[str, dict]:
    out = copy.deepcopy(SPECS)
    for name, over in (cfg["export"].get("specs") or {}).items():
        out.setdefault(name, {"label": name, "file": f"{name}.mp4"}).update(over)
    return out


def plan(info: dict, spec: dict) -> dict:
    """What (if anything) must change for `info` (media.summarize + bytes) to meet `spec`."""
    v, a = info.get("video") or {}, info.get("audio") or {}
    dur = float(info.get("duration") or 0)
    reasons, video, audio = [], False, False
    if spec.get("max_seconds") and dur > spec["max_seconds"] + 0.05:
        return {"action": "skip", "reasons": [f"{dur:.1f}s is over {spec['label']}'s {spec['max_seconds']}s limit"]}
    if (v.get("width"), v.get("height")) != (COMMON["width"], COMMON["height"]):
        video = True
        reasons.append(f"resolution {v.get('width')}x{v.get('height')} -> 1080x1920")
    if v.get("codec") != COMMON["codec"] or v.get("pix_fmt") not in (None, COMMON["pix_fmt"]):
        video = True
        reasons.append(f"video {v.get('codec')}/{v.get('pix_fmt')} -> h264/yuv420p")
    fps = media.fps_value(v.get("fps"))
    if spec.get("max_fps") and fps > spec["max_fps"] + 0.01:
        video = True
        reasons.append(f"{fps:.2f} fps -> {spec['max_fps']}")
    vbr = v.get("bit_rate") or (8 * info.get("bytes", 0) / dur if dur else 0)
    if spec.get("max_video_mbps") and vbr > spec["max_video_mbps"] * 1e6:
        video = True
        reasons.append(f"video {vbr / 1e6:.1f} Mbps -> <= {spec['max_video_mbps']} Mbps")
    if spec.get("max_mb") and info.get("bytes", 0) > spec["max_mb"] * 1e6:
        video = True
        reasons.append(f"{info['bytes'] / 1e6:.0f} MB -> <= {spec['max_mb']} MB")
    if a.get("codec") != COMMON["audio_codec"]:
        audio = True
        reasons.append(f"audio {a.get('codec')} -> aac")
    if spec.get("max_audio_kbps") and (a.get("bit_rate") or 0) > spec["max_audio_kbps"] * 1000 + 999:
        audio = True
        reasons.append(f"audio {(a.get('bit_rate') or 0) // 1000} kbps -> {spec['max_audio_kbps']} kbps")
    if not (video or audio):
        return {"action": "use_master", "reasons": ["master already meets the spec"]}
    return {"action": "encode", "video": video, "audio": audio, "reasons": reasons}


def encode_cmd(ffmpeg: str, src: Path, dst: Path, p: dict, spec: dict, info: dict) -> list[str]:
    cmd = [ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", str(src),
           "-map", "0:v:0", "-map", "0:a:0"]
    if p.get("video"):
        fps = media.fps_value((info.get("video") or {}).get("fps"))
        vf = "scale=1080:1920:force_original_aspect_ratio=decrease:flags=lanczos," \
             "pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p"
        cmd += ["-vf", vf, "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-profile:v", "high",
                "-level:v", "4.2"]
        caps = []
        if spec.get("max_video_mbps"):
            caps.append(spec["max_video_mbps"] * 0.9)
        if spec.get("max_mb") and info.get("duration"):
            caps.append(spec["max_mb"] * 8 * 0.92 / float(info["duration"]) - (spec.get("max_audio_kbps") or 192) / 1000)
        if caps:
            cap = max(1.0, min(caps))
            cmd += ["-maxrate", f"{cap:.2f}M", "-bufsize", f"{2 * cap:.2f}M"]
        if spec.get("max_fps") and fps > spec["max_fps"] + 0.01:
            cmd += ["-r", str(spec["max_fps"])]
    else:
        cmd += ["-c:v", "copy"]
    if p.get("audio"):
        cmd += ["-c:a", "aac", "-b:a", f"{spec.get('max_audio_kbps') or 192}k", "-ar", "48000"]
    else:
        cmd += ["-c:a", "copy"]
    return cmd + ["-movflags", "+faststart", str(dst)]


def export_all(cfg, short: Path, out_dir: Path, platforms: list[str] | None = None) -> dict:
    """Make platform files for `short` in `out_dir`. Returns the manifest (also written)."""
    ff, fp = cfg["extract"]["ffmpeg"], cfg["extract"]["ffprobe"]
    out_dir.mkdir(parents=True, exist_ok=True)
    info = media.summarize(media.probe(fp, short))
    info["bytes"] = short.stat().st_size
    table = specs(cfg)
    manifest_path = out_dir / "manifest.json"
    old = {}
    if manifest_path.exists():
        try:
            old = json.loads(manifest_path.read_text(encoding="utf-8")).get("platforms", {})
        except ValueError:
            old = {}
    master_mtime = short.stat().st_mtime
    result: dict[str, dict] = {}
    for name in platforms or cfg["export"]["platforms"]:
        spec = table.get(name)
        if spec is None:
            result[name] = {"status": "error", "reasons": [f"unknown platform {name!r}"]}
            continue
        p = plan(info, spec)
        entry: dict = {"label": spec["label"], "reasons": p["reasons"]}
        if p["action"] == "skip":
            entry.update(status="skipped", file=None)
        elif p["action"] == "use_master":
            stale = out_dir / spec["file"]
            if stale.exists():  # made from an older master; park it in work/ (storage cleans work/)
                parked = out_dir.parent / "work" / f"superseded_{int(time.time())}_{spec['file']}"
                parked.parent.mkdir(parents=True, exist_ok=True)
                os.replace(stale, parked)
            entry.update(status="ok", file="../short.mp4", reencoded=False)
        else:
            dst = out_dir / spec["file"]
            prev = old.get(name, {})
            if dst.exists() and dst.stat().st_mtime >= master_mtime and prev.get("status") == "ok":
                result[name] = prev
                continue
            tmp = dst.with_suffix(".partial.mp4")
            try:
                media.run(encode_cmd(ff, short, tmp, p, spec, info), timeout=1800)
                check = media.verify_playable(ff, fp, tmp)
                check["bytes"] = tmp.stat().st_size
                again = plan(check, spec)
                if again["action"] != "use_master":
                    raise media.MediaError("export still out of spec: " + "; ".join(again["reasons"]))
                os.replace(tmp, dst)
                entry.update(status="ok", file=spec["file"], reencoded=True,
                             video_reencoded=bool(p.get("video")), audio_reencoded=bool(p.get("audio")),
                             bytes=dst.stat().st_size)
            except (media.MediaError, OSError) as e:
                tmp.unlink(missing_ok=True)
                entry.update(status="error", file=None, error=str(e)[:400])
        result[name] = entry
    manifest = {"master": "../short.mp4", "master_media": info, "platforms": result,
                "published": False, "written_utc": utc_iso(time.time())}
    write_json(manifest_path, manifest)
    lines = ["Upload files (nothing is uploaded automatically):", ""]
    for name, e in result.items():
        target = e.get("file") or f"- not exported ({'; '.join(e.get('reasons') or [e.get('error', '')])})"
        lines.append(f"  {e.get('label', name):<16} {target}")
    lines += ["", "Use thumbnail.jpg / cover.jpg from this folder, and the text in ../description.txt."]
    (out_dir / "UPLOAD.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return manifest
