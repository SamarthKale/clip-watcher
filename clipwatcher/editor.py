"""STEP 6 - Hand each raw clip to Claude Code, the creative editor.

For every transcribed clip this stage writes an editing job package to
jobs/<event_id>/ (EDIT_JOB.md + job.json) that points Claude at the raw clip,
transcript, word timings, chat around the spike, spike statistics, frames and
attribution. Claude then decides the segment, duration, vertical framing,
captions, zooms and effects, renders with FFmpeg, inspects the result and
saves the Short to shorts/<event_id>/.

edit.mode = "claude": runs `claude -p` headless on each job, one at a time.
edit.mode = "manual": leaves jobs marked 'manual'; open Claude Code in this
                      folder and run /edit-short to work through them.

Nothing is ever published. `finish` validates the output and writes the
attribution metadata that must travel with every Short.
"""
from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import time
from pathlib import Path

from . import media
from .config import Config
from .db import DB
from .extractor import clip_dir
from .soundlib import ASSETS_DIR, load_library, usable_items
from .util import channel_url, read_json, utc_iso, which, write_json
from .worker import Done, Skip

log = logging.getLogger("edit")

PLAYBOOK_PATH = Path(__file__).resolve().parent.parent / ".claude" / "skills" / "edit-short" / "SKILL.md"


def job_dir(cfg: Config, event_id: str) -> Path:
    return cfg.path("jobs") / event_id


def short_dir(cfg: Config, event_id: str) -> Path:
    """Edited Clips library (internal drive): <edited_dir>/<streamer>/<date>/<event>/"""
    from .storage import edited_root, library_subpath
    return edited_root(cfg) / library_subpath(event_id)


def legacy_short_dir(cfg: Config, event_id: str) -> Path:
    return cfg.path("shorts") / event_id


def _rel(cfg: Config, p: Path) -> str:
    try:
        return p.resolve().relative_to(cfg.root.resolve()).as_posix()
    except ValueError:
        return str(p)


def _chat_excerpt(chat: dict, spike_t: float, limit: int = 60) -> list[str]:
    msgs = chat.get("messages", [])
    # Favor messages right around/after the spike, where the reaction is.
    msgs = sorted(msgs, key=lambda m: abs(m.get("clip_t", 0) - (spike_t + 5)))[:limit]
    msgs.sort(key=lambda m: m.get("clip_t", 0))
    return [f"[{m.get('clip_t', 0):7.1f}s] {m.get('name')}: {m.get('text')}" for m in msgs]


def prepare_job(cfg: Config, event_id: str) -> Path:
    raw = clip_dir(cfg, event_id)
    meta = read_json(raw / "metadata.json")
    jdir, sdir = job_dir(cfg, event_id), short_dir(cfg, event_id)
    jdir.mkdir(parents=True, exist_ok=True)
    (sdir / "work").mkdir(parents=True, exist_ok=True)
    chat = read_json(raw / "chat_context.json") if (raw / "chat_context.json").exists() else {}
    srt = raw / "transcript.srt"
    spike = meta["spike"]
    st = spike["stats"]
    att = meta["attribution"]
    max_len = cfg["edit"]["max_short_seconds"]
    py = Path(sys.executable).name if which(Path(sys.executable).name) else sys.executable

    files = {
        "raw_clip": _rel(cfg, raw / "clip.mp4"),
        "metadata": _rel(cfg, raw / "metadata.json"),
        "transcript_srt": _rel(cfg, srt) if srt.exists() else None,
        "words": _rel(cfg, raw / "words.json") if (raw / "words.json").exists() else None,
        "chat_context": _rel(cfg, raw / "chat_context.json"),
        "frames_dir": _rel(cfg, raw / "frames"),
        "output_dir": _rel(cfg, sdir),
        "work_dir": _rel(cfg, sdir / "work"),
        "playbook": _rel(cfg, PLAYBOOK_PATH),
    }
    job = {
        "event_id": event_id,
        "created_utc": utc_iso(time.time()),
        "attribution": att,
        "recording_session": meta["recording"]["session_id"],
        "source_clip_timestamps": {k: meta["clip"][k] for k in
                                   ("source_start", "source_end", "source_start_utc", "source_end_utc")},
        "spike": {k: spike[k] for k in ("spike_in_clip_s", "peak_in_clip_s", "spike_utc")},
        "spike_stats": st,
        "clip_media": meta["clip"]["media"],
        "frames": meta.get("frames", []),
        "files": files,
        "constraints": {"aspect": "9:16", "resolution": "1080x1920", "max_seconds": max_len,
                        "publish": False},
        "finish_command": f"{py} -m clipwatcher finish {event_id}",
    }
    write_json(jdir / "job.json", job)

    transcript = srt.read_text(encoding="utf-8", errors="replace").strip() if srt.exists() else \
        "(no transcript - transcription disabled or failed; listen to the audio track)"
    frames = "\n".join(f"- {f['t']:6.1f}s  {files['frames_dir']}/{Path(f['file']).name}  ({f['kind']})"
                       for f in meta.get("frames", [])) or "- (none)"
    chat_lines = "\n".join(_chat_excerpt(chat, spike["spike_in_clip_s"])) or "(no chat captured)"
    usable = usable_items(load_library())
    library_summary = ", ".join(it["id"] for it in usable) or "(none - run `python -m clipwatcher make-assets`)"
    brief = f"""# Editing job {event_id}

You are the creative editor. Turn this raw Twitch footage into one YouTube Short.
Follow the playbook in `{files['playbook']}` (read it first).

## Source & attribution (must be kept)
- Streamer: **{att['streamer']}** - {att['channel_url']}
- Recording session: `{meta['recording']['session_id']}`
- Raw clip covers recording {meta['clip']['source_start']} -> {meta['clip']['source_end']}
  ({meta['clip']['source_start_utc']} -> {meta['clip']['source_end_utc']})
- Event: `{event_id}`

## Tools
- ffmpeg: `{Path(cfg['extract']['ffmpeg']).as_posix()}`
- ffprobe: `{Path(cfg['extract']['ffprobe']).as_posix()}`
- Editing toolkit: `{py} -m clipwatcher.editkit` (captions, audiomix, trimgraph, inspect, library);
  see the playbook. Licensed sounds available: {library_summary}

## Files (read-only inputs - never modify them)
- Raw clip: `{files['raw_clip']}`  ({meta['clip']['media'].get('duration', 0):.1f}s, {json.dumps(meta['clip']['media'].get('video', {}))})
- Metadata: `{files['metadata']}`
- Transcript (SRT, clip-relative): `{files['transcript_srt']}`
- Word timings: `{files['words']}`
- Chat around the spike: `{files['chat_context']}`
- Frames: `{files['frames_dir']}/`

## The spike
Chat jumped at **{spike['spike_in_clip_s']:.1f}s** into the clip and peaked at **{spike['peak_in_clip_s']:.1f}s**
({st['first_count']} msgs in {st['bucket_seconds']:.0f}s vs a baseline of {st['baseline']}, {st['first_ratio']}x;
peak {st['peak_count']} msgs, {st['peak_ratio']}x; {st['run_buckets']} spike bucket(s)).
Chat reacts *after* the moment - the real start is usually earlier. Decide from the footage.

## Frames
{frames}

## Chat (clip time, nearest the spike)
```
{chat_lines}
```

## Transcript
```
{transcript}
```

## Deliverables in `{files['output_dir']}/`
1. `short.mp4` - 1080x1920, H.264 + AAC, <= {max_len}s, about -14 LUFS, with your captions, motion and sound design.
2. `edit_decisions.json` - logline, moment_type, beats, segments, in/out (clip and recording time),
   composition, captions, effects, audio_assets (library ids), hook, revisions, rejected_alternatives.
3. `description.txt` - 3 title options, description, the credit line for {att['streamer']}
   ({att['channel_url']}), any audio credits, and hashtags.
Use `{files['work_dir']}/` for intermediate files.

When done, run `{job['finish_command']}` and fix anything it reports.
Do not upload or publish anything.
"""
    (jdir / "EDIT_JOB.md").write_text(brief, encoding="utf-8")
    return jdir


def rejected(cfg: Config, event_id: str) -> bool:
    """Claude may decline a clip (nothing worth a Short, ToS/privacy concerns...)."""
    p = short_dir(cfg, event_id) / "edit_decisions.json"
    try:
        return bool(json.loads(p.read_text(encoding="utf-8")).get("rejected"))
    except (OSError, ValueError, AttributeError):
        return False


def finish(cfg: Config, db: DB | None, event_id: str) -> list[str]:
    """Validate a finished Short; write its attribution metadata. Returns problems."""
    sdir = short_dir(cfg, event_id)
    raw_meta_path = clip_dir(cfg, event_id) / "metadata.json"
    problems: list[str] = []
    short = sdir / "short.mp4"
    if not raw_meta_path.exists():
        return [f"no raw clip metadata for {event_id}"]
    raw_meta = read_json(raw_meta_path)
    att = raw_meta["attribution"]
    if rejected(cfg, event_id):
        if db is not None:
            row = db.job(event_id, "edit")
            if row is not None and row["status"] != "rejected":
                db.complete(row["id"], {}, status="rejected", note="editor rejected the clip",
                            next_stage="archive")
        return []
    info = {}
    if not short.exists():
        problems.append(f"missing {short}")
    else:
        try:
            info = media.verify_playable(cfg["extract"]["ffmpeg"], cfg["extract"]["ffprobe"], short)
            info.update(media.loudness(cfg["extract"]["ffmpeg"], short))
        except media.MediaError as e:
            problems.append(f"short.mp4 is not a complete, playable video: {e}")
        v, a, dur = info.get("video"), info.get("audio"), info.get("duration", 0)
        if info and not v:
            problems.append("short.mp4 has no video stream")
        if info and not a:
            problems.append("short.mp4 has no audio stream")
        if v and not (v["height"] > v["width"]):
            problems.append(f"short.mp4 is {v['width']}x{v['height']}, expected vertical 9:16")
        max_len = float(cfg["edit"]["max_short_seconds"])
        if info and dur > max_len + 0.5:
            problems.append(f"short.mp4 is {dur:.1f}s, limit is {max_len:.0f}s")
        if info and dur < 3:
            problems.append(f"short.mp4 is only {dur:.1f}s")
        lufs, tp = info.get("lufs"), info.get("true_peak_db")
        if lufs is not None and not (-17.0 <= lufs <= -11.0):
            problems.append(f"loudness is {lufs} LUFS; mix to about -14 (editkit audiomix does this)")
        if tp is not None and tp > -0.5:
            problems.append(f"true peak is {tp} dB; keep it at or below -1 dB")
    desc_text = ""
    desc = sdir / "description.txt"
    if not desc.exists():
        problems.append("missing description.txt")
    else:
        desc_text = desc.read_text(encoding="utf-8", errors="replace")
        if att["channel_url"].split("//", 1)[1] not in desc_text:
            problems.append(f"description.txt must link {att['channel_url']}")
    decisions = sdir / "edit_decisions.json"
    dec: dict = {}
    if not decisions.exists():
        problems.append("missing edit_decisions.json")
    else:
        try:
            dec = json.loads(decisions.read_text(encoding="utf-8"))
        except ValueError as e:
            problems.append(f"edit_decisions.json is not valid JSON: {e}")
    audio_used = []
    if isinstance(dec, dict):
        lib_items = {it["id"]: it for it in usable_items(load_library())}
        for aid in dec.get("audio_assets", []) or []:
            aid = str(aid)
            if "/" not in aid:
                aid = next((k for k in lib_items if k.endswith("/" + aid)), aid)
            item = lib_items.get(aid)
            if item is None:
                problems.append(f"audio asset {aid!r} is not a licensed library item")
                continue
            audio_used.append({"id": aid, "license": item["license"], "credit": item.get("credit", "")})
            if item.get("credit") and item["credit"] not in desc_text:
                problems.append(f"description.txt must include the credit for {aid}: {item['credit']!r}")

    if not problems:
        write_json(sdir / "metadata.json", {
            "event_id": event_id,
            "attribution": att,
            "credit_line": att["credit_line"],
            "recording_session": raw_meta["recording"]["session_id"],
            "source_clip": {k: raw_meta["clip"][k] for k in
                            ("source_start", "source_end", "source_start_s", "source_end_s",
                             "source_start_utc", "source_end_utc")},
            "spike": raw_meta["spike"],
            "short": info,
            "audio_assets": audio_used,
            "raw_clip": _rel(cfg, clip_dir(cfg, event_id) / "clip.mp4"),
            "published": False,
            "finished_utc": utc_iso(time.time()),
        })
        if db is not None:
            row = db.job(event_id, "edit")
            if row is not None and row["status"] != "done":
                db.complete(row["id"], {"short": str(short)}, status="done", note="finished",
                            next_stage="archive")
    return problems


def _claude_cmd(cfg: Config) -> list[str]:
    e = cfg["edit"]
    binary = which(e["claude"]) or e["claude"]
    tools = list(e["allowed_tools"])
    for key in ("ffmpeg", "ffprobe"):  # also allow configured absolute paths
        b = cfg["extract"][key]
        if b not in ("ffmpeg", "ffprobe"):
            tools.append(f"Bash({Path(b).as_posix()} *)")
    cmd = [binary, "-p", "--output-format", "json", "--max-turns", str(e["max_turns"]),
           "--allowedTools", ",".join(tools),
           "--add-dir", str(cfg.data_dir), "--add-dir", str(PLAYBOOK_PATH.parent),
           "--add-dir", str(ASSETS_DIR)]
    return cmd + [str(a) for a in e.get("extra_args", [])]


def handle(cfg: Config, db: DB, job) -> Done | Skip:
    event_id = job["event_id"]
    if not (clip_dir(cfg, event_id) / "metadata.json").exists():
        return Skip("raw clip metadata missing")
    jdir = prepare_job(cfg, event_id)
    if rejected(cfg, event_id):
        return Done({}, status="rejected", note="editor rejected the clip")
    if (short_dir(cfg, event_id) / "short.mp4").exists() and not finish(cfg, None, event_id):
        return Done({"short": str(short_dir(cfg, event_id) / "short.mp4")}, note="already finished")

    if cfg["edit"]["mode"] != "claude":
        return Done({"job": str(jdir)}, status="manual",
                    note="waiting for a Claude Code session (/edit-short)")

    if which(cfg["edit"]["claude"]) is None:
        raise RuntimeError("Claude Code CLI not found; install it or set edit.mode = \"manual\"")
    prompt = (f"Read {_rel(cfg, jdir / 'EDIT_JOB.md')} and carry out that editing job completely, "
              f"following {_rel(cfg, PLAYBOOK_PATH)}. Inspect your render before finishing.")
    log.info("handing %s to Claude Code", event_id)
    env = dict(os.environ)
    # editkit (run by Claude) must find this config and this package from any folder
    if cfg.source is not None:
        env["CLIPWATCHER_CONFIG"] = str(cfg.source)
    pkg_parent = str(PLAYBOOK_PATH.parent.parent.parent.parent)
    env["PYTHONPATH"] = os.pathsep.join(p for p in (pkg_parent, env.get("PYTHONPATH")) if p)
    proc = subprocess.run(_claude_cmd(cfg), input=prompt, cwd=str(cfg.root), env=env, capture_output=True,
                          text=True, encoding="utf-8", errors="replace",
                          timeout=cfg["edit"]["timeout_seconds"])
    (jdir / "claude_run.json").write_text(proc.stdout or "", encoding="utf-8")
    if proc.stderr:
        (jdir / "claude_run.stderr.txt").write_text(proc.stderr, encoding="utf-8")
    problems = finish(cfg, None, event_id)
    if problems:
        raise RuntimeError(f"Claude exited {proc.returncode}; output not valid: " + "; ".join(problems))
    if rejected(cfg, event_id):
        return Done({}, status="rejected", note="editor rejected the clip")
    return Done({"short": str(short_dir(cfg, event_id) / "short.mp4")})
