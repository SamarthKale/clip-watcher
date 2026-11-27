"""Command-line entry point:  python -m clipwatcher <command> [options]"""
from __future__ import annotations

import argparse
import json
import logging
import os
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

from .config import load_config
from .db import DB
from .util import STOP, install_stop_handlers, setup_logging, utc_iso, which

STAGE_PROCESSES = ("record", "chat", "detect", "audiodetect", "extract", "transcribe", "edit", "storage")


def _common(p: argparse.ArgumentParser) -> None:
    p.add_argument("--config", default="config.toml", help="TOML config file (default: config.toml)")
    p.add_argument("--channel", help="Twitch channel login or URL (overrides config)")
    p.add_argument("-v", "--verbose", action="store_true")


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="clipwatcher", description="Twitch chat-spike clip pipeline")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("run", help="run the whole pipeline continuously (each stage in its own process)")
    _common(p)
    p.add_argument("--for", dest="duration", type=float, default=0,
                   help="stop gracefully after this many seconds (default: run until Ctrl+C)")
    for name, help_ in [
        ("record", "STEP 1: record the channel with streamlink"),
        ("chat", "STEP 2: read Twitch chat into chat.log"),
        ("detect", "STEP 3: detect chat spikes and queue events"),
        ("audiodetect", "STEP 3b (optional): detect loudness spikes in the recording"),
        ("extract", "STEP 4: extract raw footage for queued events"),
        ("transcribe", "STEP 5: transcribe raw clips with whisper.cpp"),
        ("edit", "STEP 6: build editing jobs and run Claude Code on them"),
        ("storage", "back up raw clips to the external drive and clean up safely"),
        ("status", "show sessions, queues and recent jobs"),
        ("check", "check that external tools and config are in place"),
        ("next-edit", "list editing jobs waiting for a manual Claude Code session"),
    ]:
        _common(sub.add_parser(name, help=help_))
    p = sub.add_parser("ui", help="open the local dashboard (Twitch only): live chat, logs, clips, start/stop")
    _common(p)
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--no-open", action="store_true", help="don't open the browser automatically")
    p = sub.add_parser("detect-file", help="run spike detection over an existing chat.log")
    _common(p)
    p.add_argument("chat_log")
    p.add_argument("--enqueue", action="store_true", help="also add the events to the extract queue")
    p = sub.add_parser("retry", help="re-queue a failed or skipped job")
    _common(p)
    p.add_argument("event_id")
    p.add_argument("stage", choices=("extract", "transcribe", "edit"))
    p = sub.add_parser("usage", help="Claude usage per video, per day and in total")
    _common(p)
    p.add_argument("--backfill", action="store_true", help="import edit runs saved before usage tracking")
    p = sub.add_parser("skip", help="skip a stuck or unwanted clip (it is still backed up, never deleted)")
    _common(p)
    p.add_argument("event_id")
    p.add_argument("stage", nargs="?", choices=("extract", "transcribe", "edit"),
                   help="default: the stage the clip is waiting in")
    p = sub.add_parser("make-assets", help="generate the original sound library and index assets/")
    _common(p)
    p.add_argument("--force", action="store_true", help="regenerate files that already exist")
    p = sub.add_parser("finish", help="validate a finished Short and write its attribution metadata")
    _common(p)
    p.add_argument("event_id")
    return ap


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    needs_channel = args.cmd in ("run", "record", "chat", "detect", "audiodetect")
    try:
        cfg = load_config(args.config, {"channel": args.channel}, require_channel=needs_channel)
    except (ValueError, FileNotFoundError) as e:
        raise SystemExit(f"clipwatcher: {e}")
    setup_logging(args.cmd, cfg.path("logs") if args.cmd in STAGE_PROCESSES else None, args.verbose)
    install_stop_handlers()
    db = DB(cfg.path("db"))
    try:
        return COMMANDS[args.cmd](cfg, db, args) or 0
    except KeyboardInterrupt:
        STOP.set()
        return 130
    finally:
        db.close()


# ------------------------------------------------------------------ stages
def cmd_record(cfg, db, args):
    from .recorder import record_forever
    record_forever(cfg, db)


def cmd_chat(cfg, db, args):
    from .chat import ChatReader, chat_log_path
    ChatReader(cfg, chat_log_path(cfg)).run_forever()


def cmd_detect(cfg, db, args):
    from .detector import detect_forever
    detect_forever(cfg, db)


def cmd_audiodetect(cfg, db, args):
    from .audio_detector import audio_detect_forever
    audio_detect_forever(cfg, db)


def cmd_extract(cfg, db, args):
    from . import extractor
    from .worker import run_worker
    run_worker(cfg, db, "extract", extractor.handle)


def cmd_transcribe(cfg, db, args):
    from . import transcriber
    from .worker import run_worker
    run_worker(cfg, db, "transcribe", transcriber.handle, lease_seconds=4000)


def cmd_storage(cfg, db, args):
    from .storage import storage_forever
    storage_forever(cfg, db)


def cmd_edit(cfg, db, args):
    from . import editor
    from .worker import run_worker
    run_worker(cfg, db, "edit", editor.handle,
               lease_seconds=cfg["edit"]["timeout_seconds"] + 600)


# --------------------------------------------------------------- supervisor
def cmd_run(cfg, db, args):
    """Start every stage as its own process and restart any that die.

    Separate processes mean a slow transcription or a long Claude edit can never
    stall recording or chat capture.
    """
    log = logging.getLogger("run")
    problems = _check(cfg, quiet=True)
    for p in problems:
        log.warning("%s", p)
    stages = list(STAGE_PROCESSES)
    if not cfg["transcribe"]["enabled"]:
        stages.remove("transcribe")
    if not cfg["detect"]["audio"]["enabled"]:  # optional second trigger, off by default
        stages.remove("audiodetect")
    base = [sys.executable, "-m", "clipwatcher"]
    config_arg = str(Path(args.config).resolve())
    extra = ["--config", config_arg, "--channel", cfg.channel] + (["-v"] if args.verbose else [])
    # Children run from the config's folder; make sure they can import this package
    # even when it isn't pip-installed.
    pkg_parent = str(Path(__file__).resolve().parent.parent)
    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join(p for p in (pkg_parent, env.get("PYTHONPATH")) if p)
    procs: dict[str, subprocess.Popen] = {}
    restarts: dict[str, float] = {s: 0.0 for s in stages}
    backoff: dict[str, float] = {s: 2.0 for s in stages}
    log.info("Clip Watcher running for twitch.tv/%s - Ctrl+C to stop", cfg.channel)
    if args.duration:
        threading.Timer(args.duration, STOP.set).start()
    # On Windows each stage gets its own process group so it can be stopped with
    # CTRL_BREAK (a graceful stop: the recorder then closes streamlink cleanly).
    popen_kw = {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == "nt" else {}
    try:
        while not STOP.is_set():
            for s in stages:
                p = procs.get(s)
                if p is not None and p.poll() is None:
                    continue
                if p is not None:
                    log.warning("stage %s exited with %s; restarting in %.0fs", s, p.returncode,
                                backoff[s])
                    restarts[s] = time.time() + backoff[s]
                    backoff[s] = min(backoff[s] * 2, 120)
                    procs.pop(s)
                    continue
                if time.time() >= restarts[s]:
                    procs[s] = subprocess.Popen(base + [s] + extra, cwd=str(cfg.root), env=env,
                                                **popen_kw)
                    log.info("started %s (pid %d)", s, procs[s].pid)
            for s, p in procs.items():  # reset backoff for stages that stayed up
                if p.poll() is None and time.time() - restarts[s] > 300:
                    backoff[s] = 2.0
            STOP.wait(1)
    finally:
        log.info("stopping stages...")
        for p in procs.values():
            if p.poll() is None:
                try:
                    p.send_signal(signal.CTRL_BREAK_EVENT if os.name == "nt" else signal.SIGTERM)
                except OSError:
                    pass
        deadline = time.time() + 20
        for p in procs.values():
            try:
                p.wait(timeout=max(0.1, deadline - time.time()))
            except subprocess.TimeoutExpired:
                p.kill()


# -------------------------------------------------------------- utilities
def cmd_detect_file(cfg, db, args):
    from pathlib import Path
    from .config import normalize_channel
    from .detector import detect_file
    channel = cfg.channel or normalize_channel(Path(args.chat_log).resolve().parent.name)
    events = detect_file(Path(args.chat_log), channel, cfg["detect"])
    for ev in events:
        s = ev.stats
        print(f"{ev.event_id}  {utc_iso(ev.spike_ts)}  count={s['first_count']} "
              f"baseline={s['baseline']} ratio={s['first_ratio']}x peak={s['peak_count']} "
              f"buckets={s['run_buckets']}")
        if args.enqueue:
            db.add_event(ev.event_id, ev.channel, ev.spike_ts, ev.peak_ts, ev.stats)
    print(f"{len(events)} spike(s)")


def cmd_status(cfg, db, args):
    print("Sessions:")
    for r in db.conn.execute("SELECT * FROM sessions ORDER BY created DESC LIMIT 10"):
        dur = (r["end_wall"] or time.time()) - r["start_wall"] if r["start_wall"] else 0
        print(f"  {r['id']:<40} {r['status']:<10} {dur/60:7.1f} min  {r['path']}")
    print("\nQueues:")
    for r in db.queue_summary():
        print(f"  {r['stage']:<11} {r['status']:<9} {r['n']}")
    from .storage import status_lines, summary
    s = summary(cfg)
    print(f"\nStorage: raw -> {s['raw_clips_dir']} | edited -> {s['edited_dir']} | "
          f"recordings archive -> {s['recordings_archive_dir']}")
    for line in status_lines(cfg, db):
        print(line)
    print("\nRecent jobs:")
    for r in db.recent_jobs(20):
        extra = r["note"] or (r["last_error"] or "").splitlines()[0:1]
        extra = extra if isinstance(extra, str) else (extra[0] if extra else "")
        print(f"  {r['event_id']:<32} {r['stage']:<11} {r['status']:<9} try {r['attempts']}  {extra[:90]}")


def cmd_retry(cfg, db, args):
    n = db.retry(args.event_id, args.stage)
    print("re-queued" if n else "no such job")
    return 0 if n else 1


def skip_job(db, event_id: str, stage: str | None = None) -> tuple[bool, str]:
    """Skip a waiting/failed job. Skipping transcribe still edits; skipping edit still backs the clip up."""
    from .worker import AFTER_TERMINAL
    stage = stage or db.open_stage(event_id)
    if stage is None:
        return False, "nothing to skip for that clip (it is done or running)"
    if not db.skip(event_id, stage):
        return False, f"{stage} is running or already finished"
    nxt = AFTER_TERMINAL.get(stage)
    if nxt:
        db.enqueue(event_id, nxt)
    return True, f"skipped {stage}" + (f"; {nxt} queued" if nxt else "")


def cmd_skip(cfg, db, args):
    ok, msg = skip_job(db, args.event_id, args.stage)
    print(msg)
    return 0 if ok else 1


def cmd_usage(cfg, db, args):
    from . import usage
    if args.backfill:
        print(f"imported {usage.backfill(cfg, db)} earlier edit run(s)")
    s = usage.summary(db)
    t = s["total"]
    print(f"{t['videos']} video(s), {t['finished']} finished, {t['attempts']} attempt(s)")
    print(f"list-price equivalent ${t['cost_usd']:.2f} total, ${t['wasted_usd']:.2f} on attempts that did not finish")
    if t["avg_per_finished_usd"] is not None:
        print(f"average per finished Short: ${t['avg_per_finished_usd']:.2f}")
    for v in s["videos"][:15]:
        print(f"  {v['event_id']:<34} {v['outcome']:<9} {v['attempts']} try  {v['turns']:>3} turns  "
              f"{(v['cache_read'] + v['input_tokens'] + v['cache_write']) / 1e6:5.2f}M in  "
              f"{v['output_tokens'] / 1000:5.1f}K out  ${v['cost_usd']:.2f}")


def cmd_finish(cfg, db, args):
    from .editor import finish
    problems = finish(cfg, db, args.event_id)
    if problems:
        print("NOT FINISHED:")
        for p in problems:
            print(f"  - {p}")
        return 1
    print(f"OK - {args.event_id} saved with attribution metadata (not published)")
    from .editor import short_dir
    from .util import read_json
    meta_path = short_dir(cfg, args.event_id) / "metadata.json"
    if meta_path.exists():
        meta = read_json(meta_path)
        final = meta.get("final") or {}
        for k in ("thumbnail", "cover"):
            if final.get(k):
                print(f"  {k:<16} {final[k]}")
        for name, e in (final.get("platforms") or {}).items():
            print(f"  {name:<16} {e.get('status')}: {e.get('file') or '-'}")
        for w in (meta.get("qa") or {}).get("warnings", []):
            print(f"  warning: {w}")
    return 0


def cmd_next_edit(cfg, db, args):
    from .editor import job_dir
    rows = db.conn.execute("SELECT * FROM jobs WHERE stage='edit' AND status='manual' "
                           "ORDER BY updated").fetchall()
    if not rows:
        print("no editing jobs waiting")
        return 0
    for r in rows:
        print(f"{r['event_id']}  {(job_dir(cfg, r['event_id']) / 'EDIT_JOB.md').as_posix()}")


def cmd_make_assets(cfg, db, args):
    from .soundlib import ASSETS_DIR, make_assets, usable_items
    lib = make_assets(force=args.force)
    print(f"{len(usable_items(lib))} usable of {len(lib['items'])} items in {ASSETS_DIR / 'library.json'}")


def cmd_ui(cfg, db, args):
    from .ui import serve
    serve(cfg, args.config, port=args.port, open_browser=not args.no_open)


def _check(cfg, quiet=False) -> list[str]:
    problems = []
    tools = [("streamlink", cfg["record"]["streamlink"], "pip install streamlink"),
             ("ffmpeg", cfg["extract"]["ffmpeg"], "winget install Gyan.FFmpeg"),
             ("ffprobe", cfg["extract"]["ffprobe"], "ships with ffmpeg")]
    if cfg["transcribe"]["enabled"]:
        tools.append(("whisper-cli", cfg["transcribe"]["whisper_cli"],
                      "https://github.com/ggml-org/whisper.cpp/releases"))
    if cfg["edit"]["mode"] == "claude":
        tools.append(("claude", cfg["edit"]["claude"], "https://claude.com/claude-code"))
    for name, binary, hint in tools:
        path = which(binary)
        if not quiet:
            print(f"  {name:<12} {'OK  ' + path if path else 'MISSING  (' + hint + ')'}")
        if not path:
            problems.append(f"{name} not found ({hint})")
    if cfg["transcribe"]["enabled"]:
        model = cfg.resolve(cfg["transcribe"]["model"])
        ok = model.exists()
        if not quiet:
            print(f"  {'model':<12} {'OK  ' if ok else 'MISSING  '}{model}")
        if not ok:
            problems.append(f"whisper model missing: {model}")
    return problems


def cmd_check(cfg, db, args):
    from .soundlib import load_library, usable_items
    from .storage import drive_ready, edited_root, raw_archive_root, recordings_archive_root
    print("Tools:")
    problems = _check(cfg)
    print("\nStorage:")
    for label, root in (("raw clips", raw_archive_root(cfg)), ("recordings", recordings_archive_root(cfg)),
                        ("edited", edited_root(cfg))):
        ok, why = drive_ready(root) if root else (False, "not configured (kept locally, nothing deleted)")
        print(f"  {label:<11} {'OK  ' if ok else 'WAIT'} {root or ''}  {'' if ok else why}")
    print(f"  sound library: {len(usable_items(load_library()))} licensed items "
          f"(run `python -m clipwatcher make-assets` if 0)")
    print(f"\nChannel: {cfg.channel or '(none set - pass --channel)'}")
    print(f"Data dir: {cfg.data_dir}")
    print(json.dumps({"edit_mode": cfg["edit"]["mode"], "threshold": cfg["detect"]["threshold"],
                      "window": [cfg["extract"]["pre_seconds"], cfg["extract"]["post_seconds"]]}))
    return 1 if problems else 0


COMMANDS = {
    "run": cmd_run, "record": cmd_record, "chat": cmd_chat, "detect": cmd_detect,
    "extract": cmd_extract, "transcribe": cmd_transcribe, "edit": cmd_edit,
    "status": cmd_status, "check": cmd_check, "detect-file": cmd_detect_file,
    "retry": cmd_retry, "finish": cmd_finish, "next-edit": cmd_next_edit,
    "make-assets": cmd_make_assets, "storage": cmd_storage, "audiodetect": cmd_audiodetect,
    "ui": lambda cfg, db, args: cmd_ui(cfg, db, args), "skip": cmd_skip, "usage": cmd_usage,
}
