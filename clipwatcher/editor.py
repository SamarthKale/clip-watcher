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

from . import export, library, media, signals, thumbs, usage
from .config import Config
from .db import DB
from .extractor import clip_dir
from .soundlib import ASSETS_DIR, load_library, usable_items
from .util import channel_url, read_json, utc_iso, which, write_json
from .worker import Done, Skip

log = logging.getLogger("edit")

PLAYBOOK_PATH = Path(__file__).resolve().parent.parent / ".claude" / "skills" / "edit-short" / "SKILL.md"
REFERENCES_DIR = PLAYBOOK_PATH.parent / "references"


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
    sig_path, sig = _signals(cfg, raw, jdir, meta, chat)
    files["signals"] = _rel(cfg, sig_path) if sig_path else None
    signal_lines = "\n".join(signals.summary_lines(sig)) if sig else "- (signals unavailable)"
    spike_text = _spike_text(spike, st)
    usable = usable_items(load_library())
    library_summary = ", ".join(it["id"] for it in usable) or "(none - run `python -m clipwatcher make-assets`)"
    target = int(cfg["edit"].get("target_short_seconds") or 0)
    length_hint = ""
    if target:
        min_len = int(cfg["edit"].get("min_short_seconds") or 0)
        length_hint = (f"\n   LENGTH: aim for about {target}s (between {max(min_len, 50)}s and {max_len}s is the sweet spot).\n"
                       f"   Never under {min_len}s and never over {max_len}s; `finish` rejects anything outside.\n"
                       "   This overrides the playbook's per-type durations. Reach the length with real footage:\n"
                       "   the set-up, the moment, the reaction and the aftermath. Never pad, loop, freeze or slow down.")
    tinfo = meta.get("transcript") or {}
    language_line = (f"{tinfo.get('language_class', 'en')}, detected {tinfo.get('detected_language') or 'en'}"
                     "; captions must be in Latin letters (Hinglish for Hindi speech), see the playbook")
    render_all_section = ""
    if cfg["edit"].get("render_all"):
        render_all_section = (
            "## Render every clip (overrides the playbook's score rule)\n"
            "The owner wants a Short from EVERY spike, whatever its score. Do NOT reject for a low\n"
            "`highlight_score`, a missing logline or \"no real moment\": a score under 50 is still\n"
            "scored and recorded honestly, but you must then make the best, shortest Short the footage\n"
            "allows (the 'cautious edit' treatment: short, carried by the payoff and captions) using the\n"
            "most interesting 10-30 s you can find. Reject ONLY for the safety and rights rules in the\n"
            "playbook's Hard rules (harassment, private information, sexual or dangerous/illegal\n"
            "content, someone else's copyrighted video or music). If you do reject, say which rule.\n\n")
    brief = f"""# Editing job {event_id}

You are the creative editor. Turn this raw Twitch footage into one YouTube Short.
Follow the playbook in `{files['playbook']}` (read it first).

## Source & attribution (must be kept)
- Streamer: **{att['streamer']}** - {att['channel_url']}
- Recording session: `{meta['recording']['session_id']}`
- Raw clip covers recording {meta['clip']['source_start']} -> {meta['clip']['source_end']}
  ({meta['clip']['source_start_utc']} -> {meta['clip']['source_end_utc']})
- Event: `{event_id}`

{render_all_section}## Tools
- ffmpeg: `{Path(cfg['extract']['ffmpeg']).as_posix()}`
- ffprobe: `{Path(cfg['extract']['ffprobe']).as_posix()}`
- Editing toolkit: `{py} -m clipwatcher.editkit` - captions, audiomix, trimgraph, inspect, library,
  signals, timeline, grid, reframe, track, snap, thumbnail (see the playbook and
  `{_rel(cfg, REFERENCES_DIR)}/`). Licensed sounds available: {library_summary}

## Files (read-only inputs - never modify them)
- Raw clip: `{files['raw_clip']}`  ({meta['clip']['media'].get('duration', 0):.1f}s, {json.dumps(meta['clip']['media'].get('video', {}))})
- Metadata: `{files['metadata']}`
- Transcript (SRT, clip-relative): `{files['transcript_srt']}`
- Word timings: `{files['words']}`
- Chat around the spike: `{files['chat_context']}`
- Frames: `{files['frames_dir']}/`
- Highlight signals: `{files['signals']}`

## The spike
{spike_text}

## Highlight signals (heuristics - confirm from the frames)
{signal_lines}

## Frames
{frames}

## Chat (clip time, nearest the spike)
```
{chat_lines}
```

## Transcript (language: {language_line})
```
{transcript}
```

## Deliverables in `{files['output_dir']}/`
1. `short.mp4` - 1080x1920, H.264 + AAC, <= {max_len}s, about -14 LUFS, with your captions, motion and sound design.{length_hint}
2. `edit_decisions.json` - logline, moment_type, highlight_score (the rubric), beats, segments,
   in/out (clip and recording time), composition, captions, effects, audio_assets (library ids),
   hook, thumbnail ({{"raw_t", "text", "accent"}}), revisions, rejected_alternatives.
3. `seo` object inside `edit_decisions.json` - the text published with the Short: title (<= 100
   chars, searchable phrase first), description (hook, context, audio credits and the credit line for
   {att['streamer']} {att['channel_url']}), hashtags (3-8), tags, keywords, hook_text (<= 60 chars),
   language, captions {{tiktok, shorts, reels}}. The playbook section 10 gives the exact rules.
Use `{files['work_dir']}/` for intermediate files.

When done, run `{job['finish_command']}` and fix anything it reports. It also renders the
thumbnail and cover and the platform files in `{files['output_dir']}/final/` (nothing is uploaded).
Do not upload or publish anything.
"""
    (jdir / "EDIT_JOB.md").write_text(brief, encoding="utf-8")
    return jdir


def _signals(cfg: Config, raw: Path, jdir: Path, meta: dict, chat: dict) -> tuple[Path | None, dict | None]:
    """signals.json from extraction, or computed now into the job folder (raw clips are read-only)."""
    for cand in (raw / "signals.json", jdir / "signals.json"):
        if cand.exists():
            try:
                return cand, read_json(cand)
            except ValueError:
                pass
    if not cfg["extract"].get("signals", True):
        return None, None
    sp = meta["spike"]
    try:
        sig = signals.analyze(cfg["extract"]["ffmpeg"], raw / "clip.mp4", chat.get("messages", []),
                              float(sp["spike_in_clip_s"]), float(sp["peak_in_clip_s"]), sp.get("stats", {}),
                              scenes=bool(cfg["extract"].get("scene_detect", True)))
    except (media.MediaError, OSError, ValueError, subprocess.TimeoutExpired) as e:
        log.warning("signals unavailable for %s: %s", meta.get("event_id"), str(e)[:200])
        return None, None
    write_json(jdir / "signals.json", sig)
    return jdir / "signals.json", sig


def _spike_text(spike: dict, st: dict) -> str:
    also = ", ".join(sorted({d.get("source", "?") for d in st.get("also_detected_by", [])}))
    also = f" Also detected by: {also}." if also else ""
    if st.get("source") == "audio":
        return (f"The **audio** got loud at **{spike['spike_in_clip_s']:.1f}s** into the clip and peaked at "
                f"**{spike['peak_in_clip_s']:.1f}s** ({st.get('peak_lufs')} LUFS vs a 5-minute baseline of "
                f"{st.get('baseline_lufs')} LUFS, +{st.get('rise_lu')} LU for {st.get('run_seconds')}s).{also}\n"
                f"An audio spike is often the moment itself (a scream, a team fight, an explosion) - "
                f"or just a loud ad/song/alert. Decide from the footage.")
    return (f"Chat jumped at **{spike['spike_in_clip_s']:.1f}s** into the clip and peaked at "
            f"**{spike['peak_in_clip_s']:.1f}s** ({st.get('first_count')} msgs in {st.get('bucket_seconds', 10):.0f}s "
            f"vs a baseline of {st.get('baseline')}, {st.get('first_ratio')}x; peak {st.get('peak_count')} msgs, "
            f"{st.get('peak_ratio')}x; {st.get('run_buckets')} spike bucket(s)).{also}\n"
            f"Chat reacts *after* the moment - the real start is usually earlier. Decide from the footage.")


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
    warnings: list[str] = []
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
            qa = media.qa_scan(cfg["extract"]["ffmpeg"], short, info.get("duration", 0))
            info.update({k: qa.pop(k) for k in ("lufs", "true_peak_db", "lra") if k in qa})
            info["qa"] = qa
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
        min_len = float(cfg["edit"].get("min_short_seconds") or 0)
        if info and min_len and 3 <= dur < min_len:
            problems.append(f"short.mp4 is {dur:.1f}s, minimum is {min_len:.0f}s: add the real set-up and "
                            f"aftermath from the raw clip (aim for about {cfg['edit'].get('target_short_seconds') or 55}s)")
        lufs, tp = info.get("lufs"), info.get("true_peak_db")
        if lufs is not None and not (-17.0 <= lufs <= -11.0):
            problems.append(f"loudness is {lufs} LUFS; mix to about -14 (editkit audiomix does this)")
        if tp is not None and tp > -0.5:
            problems.append(f"true peak is {tp} dB; keep it at or below -1 dB")
        p2, w2 = _qa_rules(info)
        problems += p2
        warnings += w2
    decisions = sdir / "edit_decisions.json"
    dec: dict = {}
    if not decisions.exists():
        problems.append("missing edit_decisions.json")
    else:
        try:
            dec = json.loads(decisions.read_text(encoding="utf-8"))
        except ValueError as e:
            problems.append(f"edit_decisions.json is not valid JSON: {e}")
    desc = sdir / "description.txt"
    if cfg["edit"].get("require_seo", True) and decisions.exists() and isinstance(dec, dict):
        seo_bad = library.seo_problems(dec.get("seo"), att["channel_url"])
        problems += seo_bad
        if not seo_bad and not desc.exists():
            desc.write_text(library.description_txt(dec["seo"]), encoding="utf-8")
    desc_text = ""
    if not desc.exists():
        problems.append("missing description.txt")
    else:
        desc_text = desc.read_text(encoding="utf-8", errors="replace")
        if att["channel_url"].split("//", 1)[1] not in desc_text:
            problems.append(f"description.txt must link {att['channel_url']}")
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
        final = _finalize(cfg, event_id, sdir, short, dec if isinstance(dec, dict) else {}, warnings)
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
            "detection": raw_meta.get("detection"),
            "signals": raw_meta.get("signals"),
            "highlight_score": dec.get("highlight_score") if isinstance(dec, dict) else None,
            "moment_type": dec.get("moment_type") if isinstance(dec, dict) else None,
            "final": final,
            "qa": {"warnings": warnings},
            "raw_clip": _rel(cfg, clip_dir(cfg, event_id) / "clip.mp4"),
            "published": False,
            "finished_utc": utc_iso(time.time()),
        })
        if db is not None:
            row = db.job(event_id, "edit")
            if row is not None and row["status"] != "done":
                db.complete(row["id"], {"short": str(short)}, status="done", note="finished",
                            next_stage="archive")
        if cfg["edit"].get("library", True):
            try:
                library.publish(cfg, db, event_id)  # a library problem never loses a finished edit
            except (OSError, ValueError, KeyError) as e:
                logging.getLogger("edit").warning("library publish of %s failed: %s", event_id, e)
    return problems


def _qa_rules(info: dict) -> tuple[list[str], list[str]]:
    """Hard problems and soft warnings from the render's QA scan."""
    problems, warnings = [], []
    v, qa = info.get("video") or {}, info.get("qa") or {}
    if v and (v.get("width"), v.get("height")) != (1080, 1920):
        problems.append(f"short.mp4 is {v.get('width')}x{v.get('height')}; render at exactly 1080x1920")
    if v and v.get("codec") != "h264":
        problems.append(f"video codec is {v.get('codec')}; use libx264 (every platform accepts H.264)")
    if v and v.get("pix_fmt") not in (None, "yuv420p"):
        problems.append(f"pixel format is {v.get('pix_fmt')}; add -pix_fmt yuv420p")
    if v and media.fps_value(v.get("fps")) > 60.5:
        problems.append(f"frame rate {media.fps_value(v.get('fps')):.1f} is over 60")
    for a, b in qa.get("black", []):
        if a < 0.05:
            problems.append(f"the Short opens on a black frame ({a:.2f}-{b:.2f}s); the first frame is the hook")
        elif b - a >= 1.0:
            problems.append(f"{b - a:.1f}s of black at {a:.1f}s")
        else:
            warnings.append(f"short black flash {a:.2f}-{b:.2f}s (fine if intended)")
    for a, b in qa.get("frozen", []):
        if b - a >= 2.5:
            problems.append(f"picture frozen for {b - a:.1f}s at {a:.1f}s (freeze-frames should be <= 1.5s)")
        elif b - a >= 1.0:
            warnings.append(f"picture still for {b - a:.1f}s at {a:.1f}s (fine for a freeze-frame or a menu)")
    for a, b in qa.get("silent", []):
        if b - a >= 1.5:
            warnings.append(f"near-silence for {b - a:.1f}s at {a:.1f}s")
    return problems, warnings


def _finalize(cfg: Config, event_id: str, sdir: Path, short: Path, dec: dict, warnings: list[str]) -> dict:
    """Thumbnail, cover and platform files in final/. Failures here are warnings, never a lost edit."""
    x = cfg["export"]
    if not x.get("enabled", True):
        return {"dir": None, "note": "export disabled"}
    out: dict = {"dir": "final"}
    final = sdir / "final"
    ff, fp = cfg["extract"]["ffmpeg"], cfg["extract"]["ffprobe"]
    final.mkdir(parents=True, exist_ok=True)
    if x.get("thumbnail", True):
        th = dec.get("thumbnail") if isinstance(dec.get("thumbnail"), dict) else {}
        raw_clip = clip_dir(cfg, event_id) / "clip.mp4"
        sig = {}
        for cand in (clip_dir(cfg, event_id) / "signals.json", job_dir(cfg, event_id) / "signals.json"):
            if cand.exists():
                try:
                    sig = read_json(cand)
                    break
                except ValueError:
                    pass
        raw_t = th.get("raw_t", (sig.get("moment_guess") or {}).get("t"))
        made_after = max(short.stat().st_mtime, (sdir / "edit_decisions.json").stat().st_mtime)
        jobs = [("thumbnail.jpg", raw_clip, raw_t, (1280, 720), th.get("text", ""), th.get("crop")),
                ("cover.jpg", short, th.get("cover_t", 0.0), (1080, 1920), th.get("cover_text", ""), None)]
        for name, src, t, size, text, crop_rect in jobs:
            dst = final / name
            key = name.split(".")[0]
            try:
                if not (dst.exists() and dst.stat().st_mtime >= made_after):
                    if t is None:
                        raise ValueError("no thumbnail time in edit_decisions.json (thumbnail.raw_t)")
                    thumbs.render(ff, src, float(t), dst, size, text, th.get("accent", "#FFD400"),
                                  th.get("font", "Arial Black"), None, th.get("position", "top"), crop_rect)
                bad = thumbs.check(fp, dst, size)
                warnings.extend(bad)
                out[key] = None if bad else f"final/{name}"
            except (media.MediaError, OSError, ValueError, TypeError) as e:
                warnings.append(f"{name} not made: {str(e)[:200]}")
                out[key] = None
    try:
        manifest = export.export_all(cfg, short, final)
        out["platforms"] = {k: {"status": v.get("status"), "file": v.get("file")}
                            for k, v in manifest["platforms"].items()}
        for k, v in manifest["platforms"].items():
            if v.get("status") != "ok":
                warnings.append(f"{k} export {v.get('status')}: "
                                f"{'; '.join(v.get('reasons') or [v.get('error', '')])}")
    except (media.MediaError, OSError, ValueError) as e:
        warnings.append(f"platform export failed: {str(e)[:200]}")
    return out


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
    cap = float(cfg["edit"].get("max_spend_usd") or 0)
    if cap and usage.spent_usd(db, event_id) >= cap:
        return Skip(f"spend cap reached (${usage.spent_usd(db, event_id):.2f} of ${cap:.2f}); raise edit.max_spend_usd to allow more")
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
    usage.save_attempt_file(jdir, job["attempts"], proc.stdout, proc.stderr)
    problems = finish(cfg, None, event_id)
    was_rejected = not problems and rejected(cfg, event_id)
    usage.record_attempt(db, event_id, job["attempts"],
                         "invalid" if problems else "rejected" if was_rejected else "done", proc.stdout)
    if problems:
        raise RuntimeError(f"Claude exited {proc.returncode}; output not valid: " + "; ".join(problems))
    if was_rejected:
        return Done({}, status="rejected", note="editor rejected the clip")
    return Done({"short": str(short_dir(cfg, event_id) / "short.mp4")})
