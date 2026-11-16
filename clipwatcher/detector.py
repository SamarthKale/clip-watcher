"""STEP 3 - Find chat activity spikes.

The default (and baseline) algorithm is the original simple one:

  1. read chat.log
  2. count messages in 10-second buckets
  3. baseline = average of the previous 5 minutes of buckets
     (strictly earlier buckets - the bucket being tested is never in its own baseline)
  4. a bucket is a spike when count >= 3 x baseline
  5. record the spike timestamp
  6. merge consecutive spike buckets and apply a cooldown, so one moment = one event
  7. queue the event for extraction

Safety rules:
  * no detection until `min_history_seconds` of valid history exist
  * the baseline is floored at `min_baseline` so a near-silent chat can't
    turn 2 messages into a "spike", and a spike bucket also needs
    `min_spike_messages` messages
  * monitoring gaps (chat disconnected, or chat.log silent for longer than
    `gap_seconds` despite heartbeats) reset the history instead of being
    counted as zero-message buckets, and the partial bucket at the start of a
    connection is discarded

The detector is driven purely by the timestamps inside chat.log (messages and
heartbeats), so running it live or over an old chat.log gives identical results.
"""
from __future__ import annotations

import logging
import math
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path

from .chat import chat_log_path, read_records
from .config import Config
from .db import DB
from .util import STOP, utc_iso

log = logging.getLogger("detect")

ALGORITHM = "chat_rolling_mean_3x"


@dataclass
class Bucket:
    start: float
    count: int
    baseline: float
    ratio: float


@dataclass
class SpikeEvent:
    event_id: str
    channel: str
    spike_ts: float       # start of the first spike bucket
    peak_ts: float        # start of the busiest bucket
    end_ts: float         # end of the last spike bucket
    stats: dict = field(default_factory=dict)


class SpikeDetector:
    def __init__(self, channel: str, d: dict):
        self.channel = channel
        self.B = float(d["bucket_seconds"])
        self.window = max(1, int(round(d["window_seconds"] / self.B)))
        self.min_history = max(1, int(math.ceil(d["min_history_seconds"] / self.B)))
        self.min_history = min(self.min_history, self.window)
        self.threshold = float(d["threshold"])
        self.min_baseline = float(d["min_baseline"])
        self.min_spike = int(d["min_spike_messages"])
        self.cooldown = float(d["cooldown_seconds"])
        self.max_run = int(d["max_run_buckets"])
        self.gap = float(d["gap_seconds"])

        self.history: deque[int] = deque(maxlen=self.window)
        self.alive = False
        self.cur_start: float | None = None
        self.cur_count = 0
        self.cur_valid = False
        self.last_t: float | None = None
        self.run: list[Bucket] = []
        self.cooldown_until = 0.0
        # (bucket_start, file offset of the bucket's first line) - for resuming
        self.offsets: deque[tuple[float, int]] = deque(maxlen=self.window + 2)

    # ---------------------------------------------------------- helpers
    def _bucket_of(self, t: float) -> float:
        return math.floor(t / self.B) * self.B

    def _reset(self, t: float | None, offset: int | None) -> list[SpikeEvent]:
        """Monitoring gap: keep any spike in progress, forget the baseline."""
        events = self._emit() if self.run else []
        self.history.clear()
        self.offsets.clear()
        self.cur_start = self._bucket_of(t) if t is not None else None
        self.cur_count = 0
        self.cur_valid = False  # the first bucket after a gap is partial
        if self.cur_start is not None and offset is not None:
            self.offsets.append((self.cur_start, offset))
        return events

    def _emit(self) -> list[SpikeEvent]:
        run, self.run = self.run, []
        if not run:
            return []
        first, peak = run[0], max(run, key=lambda b: b.count)
        end = run[-1].start + self.B
        self.cooldown_until = end + self.cooldown
        ev = SpikeEvent(
            event_id=f"{self.channel}-{int(first.start)}",
            channel=self.channel,
            spike_ts=first.start,
            peak_ts=peak.start,
            end_ts=end,
            stats={
                "algorithm": ALGORITHM,
                "bucket_seconds": self.B,
                "window_seconds": self.window * self.B,
                "threshold": self.threshold,
                "min_baseline": self.min_baseline,
                "min_spike_messages": self.min_spike,
                "spike_utc": utc_iso(first.start),
                "peak_utc": utc_iso(peak.start),
                "baseline": round(first.baseline, 3),
                "first_count": first.count,
                "first_ratio": round(first.ratio, 2),
                "peak_count": peak.count,
                "peak_ratio": round(peak.ratio, 2),
                "run_buckets": len(run),
                "run_messages": sum(b.count for b in run),
                "buckets": [{"start": b.start, "count": b.count, "baseline": round(b.baseline, 3),
                             "ratio": round(b.ratio, 2)} for b in run],
            },
        )
        return [ev]

    def _finalize(self, start: float, count: int, valid: bool) -> list[SpikeEvent]:
        if not valid:
            return []
        spike, baseline, ratio = False, 0.0, 0.0
        if len(self.history) >= self.min_history:
            baseline = sum(self.history) / len(self.history)  # strictly previous buckets
            effective = max(baseline, self.min_baseline)
            ratio = count / effective
            spike = count >= self.threshold * effective and count >= self.min_spike
        self.history.append(count)

        events: list[SpikeEvent] = []
        if spike and (self.run or start >= self.cooldown_until):
            self.run.append(Bucket(start, count, baseline, ratio))
            if len(self.run) >= self.max_run:
                events += self._emit()
        elif self.run:
            events += self._emit()
        return events

    def _advance_to(self, t: float, offset: int | None) -> list[SpikeEvent]:
        events: list[SpikeEvent] = []
        assert self.cur_start is not None
        while t >= self.cur_start + self.B:
            events += self._finalize(self.cur_start, self.cur_count, self.cur_valid)
            self.cur_start += self.B
            self.cur_count = 0
            self.cur_valid = True
            if offset is not None:
                self.offsets.append((self.cur_start, offset))
        return events

    # ------------------------------------------------------------- input
    def feed(self, rec: dict, offset: int | None = None) -> list[SpikeEvent]:
        kind, t = rec.get("type"), rec.get("t")
        if t is None:
            return []
        events: list[SpikeEvent] = []
        if kind == "disconnect":
            if self.cur_start is not None and self.alive:
                events += self._advance_to(t, offset)
            events += self._reset(None, None)
            self.alive = False
            self.last_t = t
            return events
        gap = self.last_t is not None and t - self.last_t > self.gap
        if kind == "connect" or not self.alive or gap or self.cur_start is None:
            events += self._reset(t, offset)
            self.alive = True
        else:
            events += self._advance_to(t, offset)
        self.last_t = t
        if kind == "msg":
            self.cur_count += 1
        return events

    def flush(self) -> list[SpikeEvent]:
        return self._emit()

    @property
    def resume_offset(self) -> int | None:
        """File offset from which replaying chat.log rebuilds the current state."""
        return self.offsets[0][1] if self.offsets else None


def detect_file(path: Path, channel: str, d: dict) -> list[SpikeEvent]:
    """Batch mode: run the detector over a complete chat.log."""
    det = SpikeDetector(channel, d)
    events: list[SpikeEvent] = []
    for offset, _, rec in read_records(path):
        events += det.feed(rec, offset)
    return events + det.flush()


def detect_forever(cfg: Config, db: DB) -> None:
    channel = cfg.channel
    path = chat_log_path(cfg)
    key = f"detector:{channel}"
    state = db.kv_get(key, {}) or {}
    offset = int(state.get("offset", 0))
    det = SpikeDetector(channel, cfg["detect"])
    det.cooldown_until = float(state.get("cooldown_until", 0.0))
    last_save = 0.0
    merge = float(cfg["detect"]["merge_window_seconds"])
    log.info("watching %s (threshold %.1fx, %ds buckets, %ds baseline)", path,
             det.threshold, det.B, det.window * det.B)

    while not STOP.is_set():
        if not path.exists():
            STOP.wait(2)
            continue
        if path.stat().st_size < offset:  # truncated/replaced
            log.warning("chat.log shrank; starting from the beginning")
            offset = 0
            det = SpikeDetector(channel, cfg["detect"])
        progressed = False
        for line_off, nxt, rec in read_records(path, offset):
            for ev in det.feed(rec, line_off):
                if db.add_event(ev.event_id, ev.channel, ev.spike_ts, ev.peak_ts, ev.stats,
                                merge_window=merge):
                    log.info("SPIKE %s at %s: %d msgs vs baseline %.1f (%.1fx), peak %d",
                             ev.event_id, utc_iso(ev.spike_ts), ev.stats["first_count"],
                             ev.stats["baseline"], ev.stats["first_ratio"], ev.stats["peak_count"])
            offset = nxt
            progressed = True
            if STOP.is_set():
                break
        now = time.time()
        if progressed and now - last_save > 5:
            resume = det.resume_offset
            db.kv_set(key, {"offset": resume if resume is not None else offset,
                            "cooldown_until": det.cooldown_until})
            last_save = now
        if not progressed:
            STOP.wait(0.5)
