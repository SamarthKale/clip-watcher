"""STEP 1 - Record the channel with Streamlink from the first available second.

Equivalent to:
    streamlink twitch.tv/CHANNEL best -o recordings/stream.ts --retry-streams 30

Each time streamlink connects it writes a new session file (never appending to,
or rewriting, an earlier one). The local wall-clock time of the first byte is
stored as the session's start_wall, which is what chat timestamps are mapped
against. When the stream ends or drops, the file is closed, marked read-only,
and streamlink goes straight back to waiting for the channel to be live.
"""
from __future__ import annotations

import logging
import os
import shutil
import stat
import subprocess
import threading
import time
from pathlib import Path

from .config import Config
from .db import DB
from .util import STOP, utc_stamp, which

log = logging.getLogger("record")


def build_command(cfg: Config, out_path: Path) -> list[str]:
    r = cfg["record"]
    cmd = [
        r["streamlink"],
        f"twitch.tv/{cfg.channel}", r["quality"],
        "-o", str(out_path),
        "--retry-streams", str(r["retry_streams"]),
        "--retry-open", str(r["retry_open"]),
        "--force",  # never prompt; paths are unique per session anyway
    ]
    cmd += [str(a) for a in r.get("extra_args", [])]
    return cmd


def _mark_read_only(path: Path) -> None:
    try:
        os.chmod(path, stat.S_IREAD | stat.S_IRGRP | stat.S_IROTH)
    except OSError as e:
        log.warning("could not mark %s read-only: %s", path, e)


def _low_disk(cfg: Config, path: Path) -> bool:
    free_gb = shutil.disk_usage(path).free / 1e9
    limit = float(cfg["record"].get("min_free_gb", 0) or 0)
    if free_gb < limit:
        log.error("only %.1f GB free on the recordings drive (minimum %.0f GB) - recording paused. "
                  "Free up space or lower record.quality.", free_gb, limit)
        return True
    return False


def _should_roll_over(cfg: Config, path: Path) -> bool:
    limit = float(cfg["record"].get("rollover_below_gb", 0) or 0)
    return limit > 0 and shutil.disk_usage(path).free / 1e9 < limit


def record_forever(cfg: Config, db: DB) -> None:
    if which(cfg["record"]["streamlink"]) is None:
        raise SystemExit("streamlink not found. Install it with:  pip install streamlink")
    channel = cfg.channel
    out_dir = cfg.path("recordings") / channel
    out_dir.mkdir(parents=True, exist_ok=True)
    db.close_stale_sessions(channel)

    while not STOP.is_set():
        if _low_disk(cfg, out_dir):
            STOP.wait(60)
            continue
        sid = f"{channel}_{utc_stamp(time.time())}"
        out_path = out_dir / f"{sid}.ts"
        db.add_session(sid, channel, str(out_path), cfg["record"]["quality"])
        cmd = build_command(cfg, out_path)
        log.info("waiting for %s to go live (session %s)", channel, sid)
        log.debug("exec: %s", " ".join(cmd))
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, encoding="utf-8", errors="replace", bufsize=1)
        start_wall: float | None = None
        last_size = 0
        last_growth = time.time()
        # Pump streamlink's output on a thread so the poll loop never blocks.
        def pump():
            assert proc.stdout is not None
            for line in proc.stdout:
                log.info("streamlink: %s", line.rstrip())
        threading.Thread(target=pump, daemon=True).start()

        last_disk_check = 0.0
        rolled_over = False
        while proc.poll() is None and not STOP.is_set():
            try:
                size = out_path.stat().st_size
            except FileNotFoundError:
                size = 0
            now = time.time()
            if now - last_disk_check > 30:
                last_disk_check = now
                if _low_disk(cfg, out_dir):
                    break
                if size > 2e9 and _should_roll_over(cfg, out_dir):
                    rolled_over = True
                    break
            if size > 0 and start_wall is None:
                # First bytes on disk: this is t=0 of the recording timeline.
                start_wall = now
                db.set_session_start(sid, start_wall)
                log.info("LIVE - recording %s -> %s", channel, out_path)
            if size > last_size:
                last_size, last_growth = size, now
            time.sleep(0.25 if start_wall is None else 1.0)

        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()

        if start_wall is None:
            # Never went live during this attempt (or streamlink errored out early).
            db.delete_session(sid)
            if out_path.exists() and out_path.stat().st_size == 0:
                out_path.unlink()
        else:
            end_wall = last_growth
            db.end_session(sid, end_wall)
            _mark_read_only(out_path)
            log.info("session %s ended after %.0fs (exit %s)", sid, end_wall - start_wall,
                     proc.returncode)
        if rolled_over:
            log.warning("internal drive below %s GB: closed %s so it can be moved to the external "
                        "drive; continuing in a new file", cfg["record"]["rollover_below_gb"], out_path.name)
            continue  # reconnect immediately to keep the gap to a few seconds
        if not STOP.is_set():
            STOP.wait(cfg["record"]["restart_backoff"])
