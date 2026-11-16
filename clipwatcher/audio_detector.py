"""Optional STEP 3b - find audio spikes in the live recording (off by default).

Chat is the default trigger, and the plain 3x chat detector stays the default.
This detector adds the moments chat misses: a streamer screaming at a clutch, a
team-wipe explosion, a jump scare. It mirrors the chat algorithm on loudness:

  1. read the recording's audio in chunks as it is written (ffmpeg ebur128)
  2. one sample per second = the loudest momentary loudness (LUFS) in that second
  3. baseline = mean of the previous 5 minutes of samples (never the tested one)
  4. a sample is a spike when it is >= `rise_lu` above the baseline AND at least
     `floor_lufs` loud, sustained for `min_seconds`
  5. merge consecutive spike seconds, cooldown, deterministic event IDs
  6. an audio spike within `merge_window_seconds` of a chat spike is the same
     moment: it is recorded on that event instead of creating a second clip

Loudness is in LU (log scale), so "+10 LU" is roughly "10x the power" - about how
much louder a scream is than normal talking.

Enable with  [detect.audio] enabled = true  in config.toml.
"""
from __future__ import annotations

import logging
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path

from . import media
from .config import Config
from .db import DB
from .signals import audio_scan
from .util import STOP, utc_iso

log = logging.getLogger("audiodetect")

ALGORITHM = "audio_loudness_rise"


@dataclass
class AudioEvent:
    event_id: str
    channel: str
    spike_ts: float  # chat-clock time (wall time minus sync offset), like chat events
    peak_ts: float
    stats: dict = field(default_factory=dict)


class AudioSpikeDetector:
    def __init__(self, channel: str, a: dict, chat_offset: float = 0.0):
        self.channel = channel
        self.window = int(a["window_seconds"])
        self.min_history = int(a["min_history_seconds"])
        self.rise = float(a["rise_lu"])
        self.floor = float(a["floor_lufs"])
        self.min_seconds = int(a["min_seconds"])
        self.cooldown = float(a["cooldown_seconds"])
        self.max_run = int(a["max_run_seconds"])
        self.gap = float(a.get("gap_seconds", 5))
        self.chat_offset = chat_offset
        self.history: deque[float] = deque(maxlen=self.window)
        self.run: list[tuple[float, float, float]] = []  # (t, lufs, baseline)
        self.last_t: float | None = None
        self.cooldown_until = 0.0

    def feed(self, t: float, lufs: float) -> list[AudioEvent]:
        """One sample per second: wall-clock time t, loudest momentary LUFS in that second."""
        events: list[AudioEvent] = []
        if self.last_t is not None and t - self.last_t > self.gap:  # recording gap: reset
            events += self._emit()
            self.history.clear()
        self.last_t = t
        spike, baseline = False, 0.0
        audible = lufs > -70
        if len(self.history) >= self.min_history:
            baseline = sum(self.history) / len(self.history)  # strictly previous samples
            spike = audible and lufs >= baseline + self.rise and lufs >= self.floor
        if audible:
            self.history.append(lufs)  # silence (muted mic, ad gap) doesn't drag the baseline down
        if spike and (self.run or t >= self.cooldown_until):
            self.run.append((t, lufs, baseline))
            if len(self.run) >= self.max_run:
                events += self._emit()
        elif self.run:
            events += self._emit()
        return events

    def flush(self) -> list[AudioEvent]:
        return self._emit()

    def _emit(self) -> list[AudioEvent]:
        run, self.run = self.run, []
        if len(run) < self.min_seconds:
            return []
        first, peak = run[0], max(run, key=lambda s: s[1])
        self.cooldown_until = run[-1][0] + 1 + self.cooldown
        spike_ts = first[0] - self.chat_offset
        return [AudioEvent(
            event_id=f"{self.channel}-{int(spike_ts)}",
            channel=self.channel,
            spike_ts=spike_ts,
            peak_ts=peak[0] - self.chat_offset,
            stats={
                "algorithm": ALGORITHM,
                "source": "audio",
                "spike_utc": utc_iso(first[0]),
                "peak_utc": utc_iso(peak[0]),
                "baseline_lufs": round(first[2], 1),
                "first_lufs": round(first[1], 1),
                "peak_lufs": round(peak[1], 1),
                "rise_lu": round(peak[1] - first[2], 1),
                "threshold_lu": self.rise,
                "floor_lufs": self.floor,
                "run_seconds": len(run),
                "window_seconds": self.window,
            },
        )]


def per_second(series: list[tuple[float, float]], skip_before: float = 0.0) -> list[tuple[float, float]]:
    """Collapse ebur128's 10 Hz series into the loudest value per whole second."""
    out: dict[int, float] = {}
    for t, v in series:
        if t < skip_before:
            continue
        k = int(t)
        out[k] = max(out.get(k, -120.0), v)
    return sorted(out.items())


def audio_detect_forever(cfg: Config, db: DB) -> None:
    """Follow recording sessions and scan their audio chunk by chunk as it is written."""
    a = cfg["detect"]["audio"]
    ff = cfg["extract"]["ffmpeg"]
    channel = cfg.channel
    chunk, safety, warm = float(a["chunk_seconds"]), float(a["safety_seconds"]), 1.0
    chat_offset = float(cfg["sync"]["chat_offset_seconds"])
    merge = float(cfg["detect"]["merge_window_seconds"])
    since = db.kv_get(f"audiodetect:{channel}:since")
    if since is None:  # never scan recordings that ended before the detector was first enabled
        since = time.time()
        db.kv_set(f"audiodetect:{channel}:since", since)
    log.info("audio detector on for %s (+%.0f LU over a %ds baseline, floor %.0f LUFS)",
             channel, a["rise_lu"], a["window_seconds"], a["floor_lufs"])
    det: AudioSpikeDetector | None = None
    det_session = None
    while not STOP.is_set():
        rows = db.conn.execute(
            "SELECT * FROM sessions WHERE channel=? AND start_wall IS NOT NULL "
            "AND (end_wall IS NULL OR end_wall >= ?) ORDER BY start_wall", (channel, since)).fetchall()
        work = None
        for s in rows:
            st = db.kv_get(f"audiodetect:{s['id']}", {}) or {}
            if not st.get("done"):
                work = (s, st)
                break
        if work is None:
            STOP.wait(5)
            continue
        sess, st = work
        if det is None or det_session != sess["id"]:
            det = AudioSpikeDetector(channel, a, chat_offset)
            det.cooldown_until = float(st.get("cooldown_until", 0.0))
            det_session = sess["id"]
        offset = float(st.get("offset", 0.0))
        live = sess["status"] == "recording"
        written = (time.time() - sess["start_wall"] - safety) if live else \
            ((sess["end_wall"] or time.time()) - sess["start_wall"])
        rec = Path(sess["path"])
        if not live and (written - offset < 1.0 or not rec.exists()):
            for ev in det.flush():
                _add(db, ev, merge)
            db.kv_set(f"audiodetect:{sess['id']}", {"offset": offset, "done": True})
            det = None
            continue
        if live and written - offset < chunk:
            STOP.wait(min(5.0, chunk - (written - offset)))
            continue
        length = min(chunk, written - offset)
        start = max(0.0, offset - warm)  # momentary loudness needs 0.4 s of warm-up
        try:
            series, _ = audio_scan(ff, rec, start=start, dur=length + (offset - start), timeout=600)
        except (media.MediaError, OSError) as e:
            log.warning("audio scan of %s at %.0fs failed: %s", rec.name, offset, str(e)[:200])
            STOP.wait(15)
            continue
        for sec, lufs in per_second(series, skip_before=offset - start):
            for ev in det.feed(sess["start_wall"] + start + sec, lufs):
                _add(db, ev, merge)
        offset += length
        db.kv_set(f"audiodetect:{sess['id']}", {"offset": offset, "cooldown_until": det.cooldown_until})


def _add(db: DB, ev: AudioEvent, merge: float) -> None:
    if db.add_event(ev.event_id, ev.channel, ev.spike_ts, ev.peak_ts, ev.stats, merge_window=merge):
        log.info("AUDIO SPIKE %s at %s: %.1f LUFS vs baseline %.1f (+%.1f LU, %ds)", ev.event_id,
                 utc_iso(ev.spike_ts), ev.stats["peak_lufs"], ev.stats["baseline_lufs"],
                 ev.stats["rise_lu"], ev.stats["run_seconds"])
    else:
        log.info("audio spike %s matches an existing event; recorded on it", ev.event_id)
