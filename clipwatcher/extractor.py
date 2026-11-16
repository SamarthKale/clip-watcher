"""STEP 4 - Extract raw footage around each spike.

Original reference:  ffmpeg -ss START -i recordings/stream.ts -t DURATION -c copy raw_clips/clip.mp4

The window is pre_seconds before and post_seconds after the spike (default
60 + 60) so the editor has enough context to find where the moment really
starts - the spike is when chat reacted, not when the moment began. Footage is
stream-copied (no re-encode, audio intact). The source recording is only ever
read, never modified.

Output per event, in raw_clips/<event_id>/:
  clip.mp4            the raw footage
  metadata.json       attribution, source timestamps, spike statistics
  chat_context.json   chat messages around the spike, with clip-relative times
  frames/             representative stills (every N seconds + spike + peak)
  signals.json        highlight signals: loudness peaks, silences, scene changes,
                      chat emote categories, moment guess and a triage score
"""
from __future__ import annotations

import json
import logging
import os
import subprocess
import time
from pathlib import Path

from . import media, signals
from .chat import chat_log_path, read_window
from .config import Config
from .db import DB
from .util import channel_url, hms, utc_iso, write_json
from .worker import Defer, Done, Skip

log = logging.getLogger("extract")


def local_clip_dir(cfg: Config, event_id: str) -> Path:
    """Staging folder on the internal drive, where clips are cut and processed."""
    return cfg.path("raw_clips") / event_id


def clip_dir(cfg: Config, event_id: str) -> Path:
    """Where the raw clip lives now: local staging, or the external Raw Cut Clips archive."""
    local = local_clip_dir(cfg, event_id)
    if local.exists():
        return local
    from .storage import library_subpath, raw_archive_root
    root = raw_archive_root(cfg)
    if root is not None and (root / library_subpath(event_id)).exists():
        return root / library_subpath(event_id)
    return local


def plan_window(spike_ts: float, chat_offset: float, start_wall: float, pre: float, post: float,
                end_wall: float | None) -> tuple[float, float, float]:
    """Map a chat spike onto the recording timeline.

    Returns (moment_offset, clip_start, clip_end) in seconds from the start of the
    recording file. The window is clamped to the footage that exists.
    """
    moment = spike_ts + chat_offset - start_wall
    start = max(0.0, moment - pre)
    end = moment + post
    if end_wall is not None:
        end = min(end, end_wall - start_wall)
    return moment, start, end


def handle(cfg: Config, db: DB, job) -> Done | Defer | Skip:
    x = cfg["extract"]
    ev = db.event(job["event_id"])
    if ev is None:
        return Skip("event row missing")
    stats = json.loads(ev["stats"])
    channel = ev["channel"]
    chat_offset = float(cfg["sync"]["chat_offset_seconds"])
    moment_wall = ev["spike_ts"] + chat_offset
    if clip_dir(cfg, ev["id"]) != local_clip_dir(cfg, ev["id"]):
        return Done({"clip": str(clip_dir(cfg, ev["id"]))}, note="already extracted and archived")
    out_dir = local_clip_dir(cfg, ev["id"])
    clip = out_dir / "clip.mp4"
    meta_path = out_dir / "metadata.json"
    if clip.exists() and meta_path.exists():
        return Done({"clip": str(clip)}, next_stage=_next_stage(cfg))  # idempotent re-run

    sess = db.session_at(channel, moment_wall)
    if sess is None:
        if time.time() - ev["created"] < 120:
            return Defer(time.time() + 15, "no recording session covers the spike yet")
        return Skip("no recording covers this moment (stream offline or recorder not running)")

    recording = Path(sess["path"])
    if not recording.exists():
        return Skip(f"recording file missing: {recording}")
    start_wall, end_wall = sess["start_wall"], sess["end_wall"]
    still_recording = sess["status"] == "recording"
    moment, start, end = plan_window(ev["spike_ts"], chat_offset, start_wall,
                                     x["pre_seconds"], x["post_seconds"],
                                     None if still_recording else end_wall)

    # Wait until enough post-spike footage has been written to disk.
    if still_recording:
        ready_at = start_wall + end + x["safety_seconds"]
        if time.time() < ready_at:
            return Defer(ready_at, f"waiting for post-spike footage until {utc_iso(ready_at)}")
    length = end - start
    if length < 5:
        return Skip(f"only {length:.1f}s of footage around the spike")

    out_dir.mkdir(parents=True, exist_ok=True)
    # Snap the cut back to a keyframe so audio and video start together; the
    # window only grows (never loses pre-spike context) and src_start is exact.
    src_start = media.keyframe_at_or_before(x["ffprobe"], recording, start)
    length = end - src_start
    tmp = out_dir / "clip.partial.mp4"
    media.run(media.cut_copy_cmd(x["ffmpeg"], recording, src_start, length, tmp), timeout=600)
    info = media.probe(x["ffprobe"], tmp)
    actual = float(info.get("format", {}).get("duration") or 0)
    give_up_waiting = start_wall + end + x["safety_seconds"] + 300
    if actual < 0.8 * length and still_recording and time.time() < give_up_waiting:
        tmp.unlink(missing_ok=True)
        return Defer(time.time() + 30, f"clip came out {actual:.1f}s of {length:.1f}s; retrying")
    os.replace(tmp, clip)
    av_offsets = {s.get("codec_type"): float(s.get("start_time") or 0) for s in info.get("streams", [])}
    if abs(av_offsets.get("video", 0) - av_offsets.get("audio", 0)) > 0.25:
        log.warning("%s: video starts at %.2fs, audio at %.2fs", ev["id"],
                    av_offsets.get("video", 0), av_offsets.get("audio", 0))
    spike_in_clip = moment - src_start
    peak_in_clip = ev["peak_ts"] + chat_offset - start_wall - src_start

    frames = _extract_frames(cfg, clip, out_dir / "frames", actual, spike_in_clip, peak_in_clip)

    ctx = float(x["chat_context_seconds"])
    msgs = read_window(chat_log_path(cfg, channel), ev["spike_ts"] - ctx, ev["spike_ts"] + ctx)
    for m in msgs:
        m["clip_t"] = round(m["t"] + chat_offset - start_wall - src_start, 2)
    write_json(out_dir / "chat_context.json", {
        "event_id": ev["id"], "window_seconds": [-ctx, ctx],
        "note": "clip_t = seconds into clip.mp4 (chat time + sync offset). Viewers react a few seconds after what they see.",
        "messages": msgs,
    })

    sig = None
    if x.get("signals", True):
        try:
            sig = signals.analyze(x["ffmpeg"], clip, msgs, spike_in_clip, peak_in_clip, stats,
                                  scenes=bool(x.get("scene_detect", True)))
            write_json(out_dir / "signals.json", sig)
        except (media.MediaError, OSError, ValueError, subprocess.TimeoutExpired) as e:
            log.warning("signal analysis failed for %s (clip is fine): %s", ev["id"], str(e)[:300])

    meta = {
        "event_id": ev["id"],
        "detection": {"source": stats.get("source", "chat"), "algorithm": stats.get("algorithm"),
                      "also_detected_by": [d.get("source") for d in stats.get("also_detected_by", [])]},
        "attribution": {
            "streamer": cfg.display_name if channel == cfg.channel else channel,
            "channel": channel,
            "channel_url": channel_url(channel),
            "credit_line": f"Streamer: {cfg.display_name if channel == cfg.channel else channel} - {channel_url(channel)}",
        },
        "recording": {
            "session_id": sess["id"],
            "path": str(recording),
            "session_start_utc": utc_iso(start_wall),
            "quality": sess["quality"],
        },
        "spike": {
            "spike_utc": utc_iso(ev["spike_ts"]),
            "peak_utc": utc_iso(ev["peak_ts"]),
            "spike_in_recording_s": round(moment, 3),
            "spike_in_recording": hms(moment),
            "spike_in_clip_s": round(spike_in_clip, 3),
            "peak_in_clip_s": round(peak_in_clip, 3),
            "chat_offset_seconds": chat_offset,
            "stats": stats,
        },
        "clip": {
            "path": str(clip),
            "source_start_s": round(src_start, 3),
            "source_end_s": round(src_start + actual, 3),
            "source_start": hms(src_start),
            "source_end": hms(src_start + actual),
            "source_start_utc": utc_iso(start_wall + src_start),
            "source_end_utc": utc_iso(start_wall + src_start + actual),
            "requested_window_s": [round(start, 3), round(end, 3)],
            "pre_seconds": x["pre_seconds"],
            "post_seconds": x["post_seconds"],
            "cut_start_snapped_to_keyframe_s": round(start - src_start, 3),
            "stream_start_times": av_offsets,
            "timing_precision": "source_start_s is the exact keyframe the stream copy starts on",
            "media": media.summarize(info),
        },
        "frames": frames,
        "signals": {"file": "signals.json", "triage_score": sig["triage"]["score"],
                    "moment_guess_s": sig["moment_guess"]["t"],
                    "suggested_moment": sig["suggested_moment"]} if sig else None,
        "chat_messages_in_context": len(msgs),
        "extracted_utc": utc_iso(time.time()),
    }
    write_json(meta_path, meta)
    log.info("extracted %s: %s-%s of %s (%.0fs), %d chat msgs", ev["id"], hms(src_start),
             hms(src_start + actual), recording.name, actual, len(msgs))
    return Done({"clip": str(clip), "duration": actual}, next_stage=_next_stage(cfg))


def _next_stage(cfg: Config) -> str:
    return "transcribe" if cfg["transcribe"]["enabled"] else "edit"


def _extract_frames(cfg: Config, clip: Path, frames_dir: Path, dur: float, spike: float,
                    peak: float) -> list[dict]:
    x = cfg["extract"]
    frames_dir.mkdir(parents=True, exist_ok=True)
    every, width = float(x["frames_every_seconds"]), int(x["frame_width"])
    out: list[dict] = []
    try:
        media.run(media.frames_cmd(x["ffmpeg"], clip, every, width, frames_dir / "f_%03d.jpg"),
                  timeout=600)
        for i, p in enumerate(sorted(frames_dir.glob("f_*.jpg"))):
            # fps filter emits the frame nearest to the middle of each interval
            t = min(dur, i * every + every / 2)
            named = frames_dir / f"t{t:07.2f}s.jpg"
            os.replace(p, named)
            out.append({"t": round(t, 2), "file": f"frames/{named.name}", "kind": "interval"})
        for kind, t in (("spike", spike), ("peak", peak)):
            if 0 <= t < dur:
                dst = frames_dir / f"{kind}_t{t:07.2f}s.jpg"
                media.run(media.frame_at_cmd(x["ffmpeg"], clip, t, width, dst), timeout=120)
                out.append({"t": round(t, 2), "file": f"frames/{dst.name}", "kind": kind})
    except media.MediaError as e:
        log.warning("frame extraction failed for %s: %s", clip, e)
    return sorted(out, key=lambda f: f["t"])
