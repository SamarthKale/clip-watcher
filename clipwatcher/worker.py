"""Generic queue worker loop shared by the extract / transcribe / edit stages."""
from __future__ import annotations

import logging
import traceback
from dataclasses import dataclass, field
from typing import Callable

from .config import Config
from .db import DB
from .util import STOP, read_json


@dataclass
class Done:
    result: dict = field(default_factory=dict)
    next_stage: str | None = None
    status: str = "done"  # or e.g. "manual" for jobs handed to a human-driven Claude session
    note: str | None = None


@dataclass
class Defer:
    until: float
    note: str


@dataclass
class Skip:
    note: str


Handler = Callable[[Config, DB, "object"], "Done | Defer | Skip"]

# Where a job goes next when it ends without the normal next stage:
#  - a transcript that can't be made still gets edited (the editor works without one)
#  - every finished edit (done, rejected or permanently failed) gets its raw clip archived
AFTER_TERMINAL = {"transcribe": "edit", "edit": "archive"}


def _triage_rank(cfg: Config):
    """Edit queue order: the clip with the highest triage score (signals.json) goes first."""
    def rank(event_id: str) -> float:
        try:
            from .extractor import clip_dir
            sig = read_json(clip_dir(cfg, event_id) / "signals.json")
            return float(sig.get("triage", {}).get("score", 0))
        except (OSError, ValueError, TypeError, AttributeError):
            return 0.0
    return rank


def process_one(cfg: Config, db: DB, stage: str, handler: Handler, lease_seconds: float) -> bool:
    """Claim and run one job. Returns False when the queue had nothing runnable."""
    log = logging.getLogger(stage)
    q = cfg["queue"]
    job = db.claim(stage, lease_seconds, rank=_triage_rank(cfg) if stage == "edit" else None)
    if job is None:
        return False
    try:
        outcome = handler(cfg, db, job)
    except Exception as e:  # noqa: BLE001 - every failure is recorded and retried
        status = db.fail(job["id"], f"{e}\n{traceback.format_exc()}", q["max_attempts"])
        log.error("%s %s failed (attempt %d, now %s): %s", stage, job["event_id"],
                  job["attempts"], status, e)
        if status == "failed" and stage in AFTER_TERMINAL:
            db.enqueue(job["event_id"], AFTER_TERMINAL[stage])
        return True
    if isinstance(outcome, Defer):
        db.defer(job["id"], outcome.until, outcome.note)
        log.debug("%s %s deferred: %s", stage, job["event_id"], outcome.note)
    elif isinstance(outcome, Skip):
        db.complete(job["id"], status="skipped", note=outcome.note,
                    next_stage=AFTER_TERMINAL.get(stage) if stage == "edit" else None)
        log.warning("%s %s skipped: %s", stage, job["event_id"], outcome.note)
    else:
        nxt = outcome.next_stage
        if nxt is None and stage == "edit" and outcome.status in ("done", "rejected"):
            nxt = "archive"
        db.complete(job["id"], outcome.result, nxt, outcome.status, outcome.note)
        log.info("%s %s -> %s%s", stage, job["event_id"], outcome.status,
                 f" (queued {nxt})" if nxt else "")
    return True


def run_worker(cfg: Config, db: DB, stage: str, handler: Handler,
               lease_seconds: float | None = None) -> None:
    log = logging.getLogger(stage)
    q = cfg["queue"]
    lease = lease_seconds or q["lease_seconds"]
    log.info("%s worker ready", stage)
    while not STOP.is_set():
        if not process_one(cfg, db, stage, handler, lease):
            STOP.wait(q["poll_seconds"])
