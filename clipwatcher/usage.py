"""Claude usage per video.

Every edit attempt (finished, rejected, failed validation, crashed) is recorded in `edit_usage`
from the JSON `claude -p` prints. Costs are the list-price equivalent Claude Code reports; on a
subscription they count against plan limits instead of being billed per clip.
"""
from __future__ import annotations

import json
import logging
import time
from datetime import datetime
from pathlib import Path

from .config import Config
from .db import DB
from .util import read_json

log = logging.getLogger("usage")


def parse_run(stdout: str) -> dict | None:
    """Token and cost numbers from `claude -p --output-format json`; None if there are none."""
    try:
        d = json.loads(stdout)
    except (TypeError, ValueError):
        return None
    if not isinstance(d, dict):
        return None
    u = d.get("usage") or {}
    mu = d.get("modelUsage") or {}
    model = ", ".join(sorted(mu)) or None
    if not u and not mu and "total_cost_usd" not in d:
        return None
    return {
        "model": model,
        "input_tokens": int(u.get("input_tokens") or 0),
        "cache_read": int(u.get("cache_read_input_tokens") or 0),
        "cache_write": int(u.get("cache_creation_input_tokens") or 0),
        "output_tokens": int(u.get("output_tokens") or 0),
        "cost_usd": float(d.get("total_cost_usd") or 0.0),
        "turns": int(d.get("num_turns") or 0),
        "duration_ms": int(d.get("duration_ms") or 0),
    }


def record_attempt(db: DB, event_id: str, attempt: int, outcome: str, stdout: str) -> dict | None:
    u = parse_run(stdout)
    if u is None:
        return None
    db.add_usage(event_id, attempt, outcome, u)
    return u


def _sum(rows) -> dict:
    return {
        "attempts": len(rows),
        "input_tokens": sum(r["input_tokens"] for r in rows),
        "cache_read": sum(r["cache_read"] for r in rows),
        "cache_write": sum(r["cache_write"] for r in rows),
        "output_tokens": sum(r["output_tokens"] for r in rows),
        "turns": sum(r["turns"] for r in rows),
        "duration_s": round(sum(r["duration_ms"] for r in rows) / 1000, 1),
        "cost_usd": round(sum(r["cost_usd"] for r in rows), 4),
        "models": sorted({m.strip() for r in rows for m in (r["model"] or "").split(",") if m.strip()}),
    }


def spent_usd(db: DB, event_id: str) -> float:
    return sum(r["cost_usd"] for r in db.usage_rows(event_id))


def usage_for_event(cfg: Config, event_id: str) -> dict | None:
    """Totals over all attempts for one clip (used by clips.json), or None if nothing was recorded."""
    db = DB(cfg.path("db"))
    try:
        rows = db.usage_rows(event_id)
        if not rows:
            return None
        out = _sum(rows)
        out["finished"] = any(r["outcome"] == "done" for r in rows)
        out["wasted_usd"] = round(sum(r["cost_usd"] for r in rows if r["outcome"] != "done"), 4)
        return out
    finally:
        db.close()


def summary(db: DB, days: int = 14) -> dict:
    """Totals, per day, per stream and per video for the dashboard."""
    rows = db.usage_rows()
    done_events = {r["event_id"] for r in rows if r["outcome"] == "done"}
    by_event: dict[str, list] = {}
    for r in rows:
        by_event.setdefault(r["event_id"], []).append(r)
    videos = []
    for ev, rs in by_event.items():
        s = _sum(rs)
        s.update({"event_id": ev, "finished": ev in done_events,
                  "outcome": rs[-1]["outcome"], "last": rs[-1]["created"],
                  "wasted_usd": round(sum(r["cost_usd"] for r in rs if r["outcome"] != "done"), 4)})
        videos.append(s)
    videos.sort(key=lambda v: v["last"], reverse=True)
    day: dict[str, list] = {}
    for r in rows:
        day.setdefault(datetime.fromtimestamp(r["created"]).date().isoformat(), []).append(r)
    per_day = [{"date": k, **_sum(v)} for k, v in sorted(day.items())][-days:]
    stream: dict[str, list] = {}
    for v in videos:
        stream.setdefault(v["event_id"].rpartition("-")[0] or v["event_id"], []).append(v)
    per_stream = []
    for ch, vs in stream.items():
        finished = [v for v in vs if v["finished"]]
        per_stream.append({"channel": ch, "videos": len(vs), "finished": len(finished),
                           "cost_usd": round(sum(v["cost_usd"] for v in vs), 4),
                           "avg_per_finished_usd": round(sum(v["cost_usd"] for v in finished) / len(finished), 4)
                           if finished else None})
    finished_videos = [v for v in videos if v["finished"]]
    total = _sum(rows)
    total.update({
        "videos": len(videos), "finished": len(finished_videos),
        "avg_per_finished_usd": round(sum(v["cost_usd"] for v in finished_videos) / len(finished_videos), 4)
        if finished_videos else None,
        "wasted_usd": round(sum(r["cost_usd"] for r in rows if r["outcome"] != "done"), 4),
        "note": "List-price equivalent. On a subscription this counts against plan limits instead of being billed.",
    })
    return {"total": total, "per_day": per_day, "per_stream": per_stream, "videos": videos[:100]}


def backfill(cfg: Config, db: DB) -> int:
    """Import runs saved before usage tracking existed (Edited Clips/**/edit_log.json); one row per clip."""
    from .storage import edited_root
    n = 0
    known = {r["event_id"] for r in db.usage_rows()}
    root = edited_root(cfg)
    for p in sorted(root.glob("*/*/*/edit_log.json")) if root.exists() else []:
        event_id = p.parent.name
        if event_id in known:
            continue
        try:
            raw = p.read_text(encoding="utf-8")
        except OSError:
            continue
        u = parse_run(raw)
        if u is None:
            continue
        db.add_usage(event_id, 1, "done", u, created=p.stat().st_mtime)
        n += 1
    return n


def save_attempt_file(jdir: Path, attempt: int, stdout: str, stderr: str) -> None:
    """Keep every attempt's raw output (the job folder used to keep only the last one)."""
    d = jdir / "claude_runs"
    d.mkdir(parents=True, exist_ok=True)
    (d / f"attempt-{attempt}.json").write_text(stdout or "", encoding="utf-8")
    if stderr:
        (d / f"attempt-{attempt}.stderr.txt").write_text(stderr, encoding="utf-8")
