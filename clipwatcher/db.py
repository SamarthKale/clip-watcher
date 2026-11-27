"""SQLite-backed state: recording sessions, spike events and per-stage job queues.

Every pipeline stage (extract, transcribe, edit) has its own queue in the
`jobs` table. Workers claim a job with a lease; if a worker crashes the lease
expires and another worker (or the restarted one) picks the job up again.
SQLite in WAL mode lets the separate stage processes share the file safely.
"""
from __future__ import annotations

import json
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

STAGES = ("extract", "transcribe", "edit", "archive")

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    channel     TEXT NOT NULL,
    path        TEXT NOT NULL,
    start_wall  REAL,           -- local epoch seconds of the first recorded byte
    end_wall    REAL,           -- set when streamlink exits
    status      TEXT NOT NULL,  -- recording | ended
    quality     TEXT,
    created     REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
    id          TEXT PRIMARY KEY,   -- deterministic: <channel>-<bucket epoch>
    channel     TEXT NOT NULL,
    spike_ts    REAL NOT NULL,      -- start of the first spike bucket (local epoch)
    peak_ts     REAL NOT NULL,
    stats       TEXT NOT NULL,      -- JSON spike statistics
    created     REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id    TEXT NOT NULL REFERENCES events(id),
    stage       TEXT NOT NULL,
    status      TEXT NOT NULL,      -- pending | running | done | failed | skipped
    attempts    INTEGER NOT NULL DEFAULT 0,
    not_before  REAL NOT NULL DEFAULT 0,
    lease_until REAL,
    last_error  TEXT,
    note        TEXT,
    result      TEXT,
    updated     REAL NOT NULL,
    UNIQUE(event_id, stage)
);
CREATE INDEX IF NOT EXISTS jobs_stage_status ON jobs(stage, status, not_before);
CREATE TABLE IF NOT EXISTS storage_log (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts      REAL NOT NULL,
    action  TEXT NOT NULL,      -- archive_raw | delete_recording | archive_recording | offload_recording
    subject TEXT NOT NULL,      -- event or session id
    src     TEXT,
    dst     TEXT,
    detail  TEXT                -- checksum or reason
);
CREATE TABLE IF NOT EXISTS edit_usage (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id      TEXT NOT NULL,
    attempt       INTEGER NOT NULL,
    model         TEXT,
    input_tokens  INTEGER NOT NULL DEFAULT 0,   -- uncached input
    cache_read    INTEGER NOT NULL DEFAULT 0,
    cache_write   INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd      REAL NOT NULL DEFAULT 0,      -- list-price equivalent reported by Claude Code
    turns         INTEGER NOT NULL DEFAULT 0,
    duration_ms   INTEGER NOT NULL DEFAULT 0,
    outcome       TEXT NOT NULL,                -- done | rejected | invalid | error
    created       REAL NOT NULL,
    UNIQUE(event_id, attempt, created)
);
CREATE INDEX IF NOT EXISTS edit_usage_event ON edit_usage(event_id);
CREATE TABLE IF NOT EXISTS kv (
    key   TEXT PRIMARY KEY,
    value TEXT
);
"""


class DB:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(self.path), timeout=30, isolation_level=None,
                                    check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA busy_timeout=30000")
        self.conn.executescript(SCHEMA)
        cols = {r["name"] for r in self.conn.execute("PRAGMA table_info(sessions)")}
        if "disposition" not in cols:  # migration: offloaded | archived | deleted
            self.conn.execute("ALTER TABLE sessions ADD COLUMN disposition TEXT")
        if "kind" not in cols:  # migration: live | vod
            self.conn.execute("ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'live'")
        if "source_url" not in cols:  # migration: the VOD link a session was made from
            self.conn.execute("ALTER TABLE sessions ADD COLUMN source_url TEXT")

    def close(self) -> None:
        self.conn.close()

    @contextmanager
    def tx(self) -> Iterator[sqlite3.Connection]:
        self.conn.execute("BEGIN IMMEDIATE")
        try:
            yield self.conn
        except BaseException:
            self.conn.execute("ROLLBACK")
            raise
        else:
            self.conn.execute("COMMIT")

    # ---------------------------------------------------------------- kv
    def kv_get(self, key: str, default: Any = None) -> Any:
        row = self.conn.execute("SELECT value FROM kv WHERE key=?", (key,)).fetchone()
        return json.loads(row["value"]) if row else default

    def kv_set(self, key: str, value: Any) -> None:
        self.conn.execute("INSERT INTO kv(key, value) VALUES(?, ?) "
                          "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                          (key, json.dumps(value)))

    # ---------------------------------------------------------- sessions
    def add_session(self, sid: str, channel: str, path: str, quality: str,
                    kind: str = "live", source_url: str | None = None) -> None:
        self.conn.execute("INSERT INTO sessions(id, channel, path, status, quality, created, kind, source_url) "
                          "VALUES(?, ?, ?, 'recording', ?, ?, ?, ?)",
                          (sid, channel, path, quality, time.time(), kind, source_url))

    def set_session_start(self, sid: str, start_wall: float) -> None:
        self.conn.execute("UPDATE sessions SET start_wall=? WHERE id=?", (start_wall, sid))

    def end_session(self, sid: str, end_wall: float | None) -> None:
        self.conn.execute("UPDATE sessions SET status='ended', end_wall=? WHERE id=?",
                          (end_wall, sid))

    def set_disposition(self, sid: str, disposition: str, new_path: str | None) -> None:
        if new_path is None:
            self.conn.execute("UPDATE sessions SET disposition=? WHERE id=?", (disposition, sid))
        else:
            self.conn.execute("UPDATE sessions SET disposition=?, path=? WHERE id=?",
                              (disposition, new_path, sid))

    def log_storage(self, action: str, subject: str, src: str | None, dst: str | None,
                    detail: str | None) -> None:
        self.conn.execute("INSERT INTO storage_log(ts, action, subject, src, dst, detail) "
                          "VALUES(?, ?, ?, ?, ?, ?)", (time.time(), action, subject, src, dst, detail))

    def delete_session(self, sid: str) -> None:
        self.conn.execute("DELETE FROM sessions WHERE id=?", (sid,))

    def session(self, sid: str) -> sqlite3.Row | None:
        return self.conn.execute("SELECT * FROM sessions WHERE id=?", (sid,)).fetchone()

    def session_at(self, channel: str, t: float) -> sqlite3.Row | None:
        """The recording session of `channel` whose timeline contains wall time t."""
        return self.conn.execute(
            "SELECT * FROM sessions WHERE channel=? AND start_wall IS NOT NULL "
            "AND start_wall <= ? AND (end_wall IS NULL OR end_wall >= ?) "
            "ORDER BY start_wall DESC LIMIT 1", (channel, t, t)).fetchone()

    def close_stale_sessions(self, channel: str) -> None:
        """Sessions left 'recording' by a crashed recorder are marked ended."""
        self.conn.execute("UPDATE sessions SET status='ended' WHERE channel=? AND status='recording'",
                          (channel,))

    # ------------------------------------------------------------ events
    def add_event(self, event_id: str, channel: str, spike_ts: float, peak_ts: float,
                  stats: dict, merge_window: float = 0.0) -> bool:
        """Insert an event and its extract job. Returns False if it already existed.

        With merge_window > 0, a spike from a *different* detector (stats["source"]:
        "chat" when absent, "audio", ...) within that many seconds of an existing event
        is the same moment: it is recorded on that event ("also_detected_by") instead of
        creating a second clip. Events from the same detector never merge, so the chat
        detector's behaviour is unchanged when it is the only one running.
        """
        with self.tx() as c:
            if merge_window > 0:
                src = stats.get("source", "chat")
                for r in c.execute("SELECT id, stats FROM events WHERE channel=? AND spike_ts BETWEEN ? AND ? "
                                   "ORDER BY ABS(spike_ts - ?)",
                                   (channel, spike_ts - merge_window, spike_ts + merge_window, spike_ts)):
                    other = json.loads(r["stats"])
                    if other.get("source", "chat") == src:
                        continue
                    seen = other.setdefault("also_detected_by", [])
                    if not any(x.get("source") == src and abs(float(x.get("spike_ts", 0)) - spike_ts) < 1
                               for x in seen):
                        seen.append({"source": src, "spike_ts": spike_ts, "peak_ts": peak_ts,
                                     **{k: v for k, v in stats.items() if k != "buckets"}})
                        c.execute("UPDATE events SET stats=? WHERE id=?", (json.dumps(other), r["id"]))
                    return False
            cur = c.execute("INSERT OR IGNORE INTO events(id, channel, spike_ts, peak_ts, stats, created) "
                            "VALUES(?, ?, ?, ?, ?, ?)",
                            (event_id, channel, spike_ts, peak_ts, json.dumps(stats), time.time()))
            if cur.rowcount == 0:
                return False
            self._enqueue(c, event_id, "extract")
            return True

    def event(self, event_id: str) -> sqlite3.Row | None:
        return self.conn.execute("SELECT * FROM events WHERE id=?", (event_id,)).fetchone()

    # -------------------------------------------------------------- jobs
    @staticmethod
    def _enqueue(c: sqlite3.Connection, event_id: str, stage: str, not_before: float = 0) -> None:
        c.execute("INSERT OR IGNORE INTO jobs(event_id, stage, status, not_before, updated) "
                  "VALUES(?, ?, 'pending', ?, ?)", (event_id, stage, not_before, time.time()))

    def enqueue(self, event_id: str, stage: str, not_before: float = 0) -> None:
        with self.tx() as c:
            self._enqueue(c, event_id, stage, not_before)

    def claim(self, stage: str, lease_seconds: float, rank=None) -> sqlite3.Row | None:
        """Atomically take the next runnable job for `stage` (or one whose lease expired).

        `rank(event_id) -> float`, when given, makes the highest-ranked runnable job go first
        (ties keep the oldest-first order)."""
        now = time.time()
        with self.tx() as c:
            rows = c.execute(
                "SELECT * FROM jobs WHERE stage=? AND ("
                " (status='pending' AND not_before<=?) OR (status='running' AND lease_until<?))"
                " ORDER BY not_before, id", (stage, now, now)).fetchall()
            if not rows:
                return None
            row = rows[0]
            if rank is not None and len(rows) > 1:
                row = max(rows, key=lambda r: (rank(r["event_id"]), -r["id"]))
            c.execute("UPDATE jobs SET status='running', attempts=attempts+1, lease_until=?, updated=? "
                      "WHERE id=?", (now + lease_seconds, now, row["id"]))
            return c.execute("SELECT * FROM jobs WHERE id=?", (row["id"],)).fetchone()

    def complete(self, job_id: int, result: dict | None = None, next_stage: str | None = None,
                 status: str = "done", note: str | None = None) -> None:
        with self.tx() as c:
            c.execute("UPDATE jobs SET status=?, result=?, note=?, lease_until=NULL, last_error=NULL, "
                      "updated=? WHERE id=?",
                      (status, json.dumps(result or {}), note, time.time(), job_id))
            if next_stage:
                ev = c.execute("SELECT event_id FROM jobs WHERE id=?", (job_id,)).fetchone()
                self._enqueue(c, ev["event_id"], next_stage)

    def defer(self, job_id: int, until: float, note: str) -> None:
        """Not an error: the job isn't ready yet (e.g. waiting for post-spike footage)."""
        self.conn.execute("UPDATE jobs SET status='pending', attempts=attempts-1, not_before=?, "
                          "lease_until=NULL, note=?, updated=? WHERE id=?",
                          (until, note, time.time(), job_id))

    def fail(self, job_id: int, error: str, max_attempts: int) -> str:
        row = self.conn.execute("SELECT attempts FROM jobs WHERE id=?", (job_id,)).fetchone()
        attempts = row["attempts"] if row else max_attempts
        if attempts >= max_attempts:
            status, not_before = "failed", 0.0
        else:
            status, not_before = "pending", time.time() + min(600, 30 * 2 ** (attempts - 1))
        self.conn.execute("UPDATE jobs SET status=?, not_before=?, lease_until=NULL, last_error=?, "
                          "updated=? WHERE id=?",
                          (status, not_before, error[-4000:], time.time(), job_id))
        return status

    def retry(self, event_id: str, stage: str) -> int:
        cur = self.conn.execute("UPDATE jobs SET status='pending', attempts=0, not_before=0, "
                                "lease_until=NULL, updated=? WHERE event_id=? AND stage=?",
                                (time.time(), event_id, stage))
        return cur.rowcount

    # ------------------------------------------------------------- usage
    def add_usage(self, event_id: str, attempt: int, outcome: str, u: dict, created: float | None = None) -> None:
        self.conn.execute(
            "INSERT OR IGNORE INTO edit_usage(event_id, attempt, model, input_tokens, cache_read, cache_write, "
            "output_tokens, cost_usd, turns, duration_ms, outcome, created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
            (event_id, attempt, u.get("model"), int(u.get("input_tokens", 0)), int(u.get("cache_read", 0)),
             int(u.get("cache_write", 0)), int(u.get("output_tokens", 0)), float(u.get("cost_usd", 0)),
             int(u.get("turns", 0)), int(u.get("duration_ms", 0)), outcome, created or time.time()))

    def usage_rows(self, event_id: str | None = None) -> list[sqlite3.Row]:
        if event_id is None:
            return self.conn.execute("SELECT * FROM edit_usage ORDER BY created").fetchall()
        return self.conn.execute("SELECT * FROM edit_usage WHERE event_id=? ORDER BY created",
                                 (event_id,)).fetchall()

    def skip(self, event_id: str, stage: str, note: str = "skipped by you") -> int:
        """Mark a waiting or failed job as skipped. A running job is left alone."""
        cur = self.conn.execute(
            "UPDATE jobs SET status='skipped', note=?, lease_until=NULL, updated=? "
            "WHERE event_id=? AND stage=? AND status IN ('pending','failed','manual')",
            (note, time.time(), event_id, stage))
        return cur.rowcount

    def open_stage(self, event_id: str) -> str | None:
        """The stage a clip is currently stuck or waiting in (pending, failed or manual), if any."""
        for stage in STAGES:
            row = self.conn.execute("SELECT status FROM jobs WHERE event_id=? AND stage=?",
                                    (event_id, stage)).fetchone()
            if row and row["status"] in ("pending", "failed", "manual"):
                return stage
        return None

    def job(self, event_id: str, stage: str) -> sqlite3.Row | None:
        return self.conn.execute("SELECT * FROM jobs WHERE event_id=? AND stage=?",
                                 (event_id, stage)).fetchone()

    def queue_summary(self) -> list[sqlite3.Row]:
        return self.conn.execute("SELECT stage, status, COUNT(*) AS n FROM jobs "
                                 "GROUP BY stage, status ORDER BY stage, status").fetchall()

    def recent_jobs(self, limit: int = 30) -> list[sqlite3.Row]:
        return self.conn.execute("SELECT * FROM jobs ORDER BY updated DESC LIMIT ?", (limit,)).fetchall()
