"""Local web dashboard for Clip Watcher (Twitch only).

    python -m clipwatcher ui            # then open http://127.0.0.1:8765

Standard library only. It shows what the pipeline sees (live chat rate, spikes, every stage's
log lines), the state of each clip, and the finished Shorts with a player. It can start and
stop the pipeline for a Twitch channel. It never uploads or publishes anything and only
listens on 127.0.0.1.
"""
from __future__ import annotations

import json
import mimetypes
import os
import re
import signal
import subprocess
import sys
import threading
import time
import webbrowser
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from . import media
from .chat import chat_log_path
from .config import Config, normalize_channel
from .db import DB
from .util import channel_url, read_json

STATIC = Path(__file__).with_name("ui_static")
LOG_LINE = re.compile(r"^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d),\d+\s+(\w+)\s+\[([^\]]+)\] (.*)$")
MEDIA_FILES = {"short.mp4": "short.mp4", "thumbnail.jpg": "final/thumbnail.jpg",
               "cover.jpg": "final/cover.jpg", "description.txt": "description.txt"}
TAIL_BYTES = 96 * 1024
FRESH_SECONDS = 20  # chat.log gets a heartbeat every few seconds while the pipeline is up


# ------------------------------------------------------------------ runner
class Runner:
    """Starts/stops `python -m clipwatcher run` as a child of the dashboard."""

    def __init__(self, cfg: Config, config_path: str):
        self.cfg = cfg
        self.config_path = str(Path(config_path).resolve())
        self.proc: subprocess.Popen | None = None
        self.channel: str | None = None
        self.started: float | None = None
        self.lock = threading.Lock()

    @property
    def log_path(self) -> Path:
        return self.cfg.path("logs") / "run.log"

    def owned_running(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def start(self, channel: str) -> str:
        with self.lock:
            if self.owned_running():
                return f"already running for {self.channel}"
            self.cfg.path("logs").mkdir(parents=True, exist_ok=True)
            out = open(self.log_path, "ab")
            flags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
            env = dict(os.environ)
            env["PYTHONPATH"] = os.pathsep.join(
                p for p in (str(Path(__file__).resolve().parent.parent), env.get("PYTHONPATH")) if p)
            self.proc = subprocess.Popen(
                [sys.executable, "-m", "clipwatcher", "run", "--config", self.config_path,
                 "--channel", channel], cwd=str(self.cfg.root), env=env, stdout=out,
                stderr=subprocess.STDOUT, creationflags=flags)
            self.channel, self.started = channel, time.time()
            return "started"

    def stop(self) -> str:
        with self.lock:
            p = self.proc
            if p is None or p.poll() is not None:
                return "not started from this dashboard"

        def _stop():
            try:
                p.send_signal(signal.CTRL_BREAK_EVENT if os.name == "nt" else signal.SIGTERM)
                p.wait(timeout=40)
            except Exception:  # noqa: BLE001
                p.kill()
        threading.Thread(target=_stop, daemon=True).start()
        return "stopping"


# ----------------------------------------------------------------- helpers
def _tail_lines(path: Path, start: int | None) -> tuple[list[str], int]:
    """Lines appended since `start` (or the last TAIL_BYTES when start is None) and the new offset."""
    try:
        size = path.stat().st_size
    except OSError:
        return [], 0
    if start is None or start > size:
        start = max(0, size - TAIL_BYTES)
        skip_partial = start > 0
    else:
        skip_partial = False
    with open(path, "rb") as fh:
        fh.seek(start)
        data = fh.read(size - start)
    cut = data.rfind(b"\n")
    if cut < 0:
        return [], start
    text = data[:cut + 1].decode("utf-8", "replace")
    lines = text.splitlines()
    if skip_partial and lines:
        lines = lines[1:]
    return lines, start + cut + 1


def _local_midnight(now: float | None = None) -> float:
    d = datetime.fromtimestamp(now or time.time())
    return d.replace(hour=0, minute=0, second=0, microsecond=0).timestamp()


def _event_state(stages: dict[str, dict]) -> tuple[str, str]:
    """(label, tone) for one clip from its per-stage job rows."""
    edit = stages.get("edit")
    if edit:
        st = edit["status"]
        if st == "done":
            return "Short ready", "ok"
        if st == "rejected":
            return "Not edited", "warn"
        if st == "failed":
            return "Edit failed", "bad"
        if st == "running":
            return "Editing", "live"
        if st == "manual":
            return "Waiting for you", "warn"
        return "Queued to edit" if edit["attempts"] == 0 else "Retrying edit", "wait"
    for name, label in (("transcribe", "Transcribing"), ("extract", "Cutting clip")):
        row = stages.get(name)
        if row:
            if row["status"] == "failed":
                return f"{label} failed", "bad"
            return label, "live" if row["status"] == "running" else "wait"
    return "Queued", "wait"


# ------------------------------------------------------------------ server
class Dashboard:
    def __init__(self, cfg: Config, config_path: str):
        self.cfg = cfg
        self.runner = Runner(cfg, config_path)
        self.duration_cache: dict[tuple[str, float], float] = {}
        self.default_channel = cfg.channel or ""

    def db(self) -> DB:
        return DB(self.cfg.path("db"))

    # ------------------------------------------------------------- status
    def pipeline_status(self, channel: str) -> dict:
        log = chat_log_path(self.cfg, channel) if channel else None
        age = None
        if log is not None and log.exists():
            age = time.time() - log.stat().st_mtime
        up = bool(self.runner.owned_running() or (age is not None and age < FRESH_SECONDS))
        return {"running": up, "owned": self.runner.owned_running(),
                "channel": self.runner.channel if self.runner.owned_running() else channel,
                "since": self.runner.started if self.runner.owned_running() else None,
                "chat_age": age}

    def shorts(self, limit: int = 60) -> list[dict]:
        from .storage import edited_root
        root = edited_root(self.cfg)
        out = []
        if not root.exists():
            return out
        files = sorted(root.glob("*/*/*/short.mp4"), key=lambda p: p.stat().st_mtime, reverse=True)
        for p in files[:limit]:
            d = p.parent
            try:
                key = (str(p), p.stat().st_mtime)
                if key not in self.duration_cache:
                    info = media.probe(self.cfg["extract"]["ffprobe"], p)
                    self.duration_cache[key] = float(info.get("format", {}).get("duration") or 0)
                dur = self.duration_cache[key]
            except Exception:  # noqa: BLE001
                dur = 0.0
            dec = {}
            try:
                dec = read_json(d / "edit_decisions.json")
            except (OSError, ValueError):
                pass
            title = ""
            try:
                m = re.search(r"^1\.\s*(.+)$", (d / "description.txt").read_text("utf-8", "replace"), re.M)
                title = m.group(1).strip() if m else ""
            except OSError:
                pass
            score = dec.get("highlight_score")
            if isinstance(score, dict):
                score = score.get("total")
            out.append({"event_id": d.name, "channel": d.parent.parent.name, "date": d.parent.name,
                        "duration": round(dur, 1), "size_mb": round(p.stat().st_size / 1e6, 1),
                        "made": p.stat().st_mtime, "title": title or dec.get("logline") or d.name,
                        "logline": dec.get("logline"), "moment": dec.get("moment_type"), "score": score,
                        "has_thumb": (d / "final" / "thumbnail.jpg").exists(),
                        "has_cover": (d / "final" / "cover.jpg").exists(), "folder": str(d)})
        return out

    def state(self, channel: str) -> dict:
        db = self.db()
        try:
            now = time.time()
            midnight = _local_midnight(now)
            ch = channel or self.default_channel
            sess = db.conn.execute(
                "SELECT * FROM sessions WHERE channel=? ORDER BY created DESC LIMIT 1", (ch,)).fetchone() \
                if ch else None
            live = bool(sess and sess["status"] == "recording" and sess["start_wall"])
            pipe = self.pipeline_status(ch)
            events = db.conn.execute("SELECT * FROM events ORDER BY spike_ts DESC LIMIT 60").fetchall()
            jobs: dict[str, dict] = {}
            for j in db.conn.execute("SELECT * FROM jobs"):
                jobs.setdefault(j["event_id"], {})[j["stage"]] = dict(j)
            rows = []
            for e in events:
                st = json.loads(e["stats"] or "{}")
                label, tone = _event_state(jobs.get(e["id"], {}))
                err = ""
                for stage in ("edit", "transcribe", "extract"):
                    j = jobs.get(e["id"], {}).get(stage)
                    if j and j.get("last_error") and j["status"] in ("failed", "pending"):
                        err = j["last_error"].strip().splitlines()[0][:160]
                        break
                rows.append({"id": e["id"], "channel": e["channel"], "spike_ts": e["spike_ts"],
                             "created": e["created"], "state": label, "tone": tone,
                             "messages": st.get("first_count"), "peak": st.get("peak_count"),
                             "baseline": st.get("baseline"), "ratio": st.get("first_ratio"),
                             "error": err})
            edit_jobs = [j.get("edit") for j in jobs.values() if j.get("edit")]
            day = {}
            for i in range(14):
                d = (datetime.fromtimestamp(now) - timedelta(days=13 - i)).date()
                day[d.isoformat()] = {"spikes": 0, "shorts": 0}
            for e in db.conn.execute("SELECT created FROM events WHERE created >= ?", (now - 15 * 86400,)):
                k = datetime.fromtimestamp(e["created"]).date().isoformat()
                if k in day:
                    day[k]["spikes"] += 1
            for j in edit_jobs:
                if j["status"] == "done":
                    k = datetime.fromtimestamp(j["updated"]).date().isoformat()
                    if k in day:
                        day[k]["shorts"] += 1
            queue = {"waiting": sum(1 for j in edit_jobs if j["status"] == "pending"),
                     "editing": sum(1 for j in edit_jobs if j["status"] == "running")}
            return {
                "now": now, "channel": ch, "channel_url": channel_url(ch) if ch else "",
                "pipeline": pipe, "live": live,
                "live_since": sess["start_wall"] if live else None,
                "stats": {"spikes_today": sum(1 for e in events if e["created"] >= midnight),
                          "shorts_today": sum(1 for j in edit_jobs if j["status"] == "done"
                                              and j["updated"] >= midnight),
                          "shorts_total": sum(1 for j in edit_jobs if j["status"] == "done"),
                          "queue": queue},
                "activity": [{"date": k, **v} for k, v in day.items()],
                "events": rows,
            }
        finally:
            db.close()

    # --------------------------------------------------------------- chat
    def chat(self, channel: str) -> dict:
        ch = channel or self.default_channel
        path = chat_log_path(self.cfg, ch) if ch else None
        res = {"connected": False, "buckets": [], "messages": [], "baseline": 0.0, "threshold": 0.0,
               "bucket_seconds": 10}
        if path is None or not path.exists():
            return res
        lines, _ = _tail_lines(path, None)
        recs = []
        for ln in lines:
            try:
                recs.append(json.loads(ln))
            except ValueError:
                continue
        if not recs:
            return res
        last = recs[-1]
        d = self.cfg["detect"]
        B = float(d["bucket_seconds"])
        now = time.time()
        res["connected"] = bool(now - last.get("t", 0) < FRESH_SECONDS and last.get("type") != "disconnect")
        n = 60
        end = int(now // B) * B
        counts = [0] * n
        for r in recs:
            if r.get("type") == "msg":
                i = int((r["t"] - (end - (n - 1) * B)) // B)
                if 0 <= i < n:
                    counts[i] += 1
        window = int(d["window_seconds"] // B)
        base_src = counts[-window - 1:-1] if len(counts) > window else counts[:-1]
        base = sum(base_src) / max(1, len(base_src))
        eff = max(base, float(d["min_baseline"]))
        res.update({"buckets": counts, "baseline": round(base, 2),
                    "threshold": round(max(eff * float(d["threshold"]), float(d["min_spike_messages"])), 1),
                    "messages": [{"t": r["t"], "name": r.get("name") or r.get("user"), "text": r.get("text")}
                                 for r in recs if r.get("type") == "msg"][-40:]})
        return res

    # --------------------------------------------------------------- logs
    def logs(self, offsets: dict | None) -> dict:
        logdir = self.cfg.path("logs")
        out_lines: list[dict] = []
        new_offsets: dict[str, int] = {}
        if logdir.exists():
            for f in sorted(logdir.glob("*.log")):
                name = f.stem
                start = None if offsets is None else offsets.get(name)
                lines, off = _tail_lines(f, start)
                new_offsets[name] = off
                prev = None
                for ln in lines:
                    m = LOG_LINE.match(ln)
                    if m:
                        prev = {"ts": m.group(1), "level": m.group(2), "stage": m.group(3), "msg": m.group(4)}
                        out_lines.append(prev)
                    elif ln.strip():  # traceback or streamlink continuation line
                        out_lines.append({"ts": prev["ts"] if prev else "", "level": prev["level"] if prev else "INFO",
                                          "stage": prev["stage"] if prev else name, "msg": ln})
        out_lines.sort(key=lambda r: r["ts"])
        if offsets is None:
            out_lines = out_lines[-400:]
        return {"offsets": new_offsets, "lines": out_lines[-800:]}

    # -------------------------------------------------------------- media
    def media_path(self, event_id: str, name: str) -> Path | None:
        rel = MEDIA_FILES.get(name)
        if rel is None or not re.fullmatch(r"[A-Za-z0-9_.-]+", event_id):
            return None
        from .storage import edited_root
        for p in edited_root(self.cfg).glob(f"*/*/{event_id}"):
            f = p / rel
            if f.is_file():
                return f
        return None


class Handler(BaseHTTPRequestHandler):
    server_version = "ClipWatcherUI"
    dash: Dashboard

    def log_message(self, *_):  # keep the console quiet
        pass

    # -- plumbing
    def _host_ok(self) -> bool:
        host = (self.headers.get("Host") or "").split(":")[0]
        return host in ("127.0.0.1", "localhost", "[::1]")

    def _send(self, code: int, body: bytes, ctype: str = "application/json", extra: dict | None = None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code: int = 200):
        self._send(code, json.dumps(obj).encode("utf-8"))

    def _serve_file(self, path: Path):
        size = path.stat().st_size
        ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        start, end = 0, size - 1
        code = 200
        rng = self.headers.get("Range")
        if rng:
            m = re.match(r"bytes=(\d*)-(\d*)", rng)
            if m:
                if m.group(1):
                    start = int(m.group(1))
                    if m.group(2):
                        end = min(int(m.group(2)), size - 1)
                elif m.group(2):
                    start = max(0, size - int(m.group(2)))
                if start > end or start >= size:
                    self._send(416, b"", extra={"Content-Range": f"bytes */{size}"})
                    return
                code = 206
        length = end - start + 1
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if code == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        try:
            with open(path, "rb") as fh:
                fh.seek(start)
                left = length
                while left > 0:
                    chunk = fh.read(min(256 * 1024, left))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    left -= len(chunk)
        except (ConnectionError, OSError):
            pass

    # -- routes
    def do_GET(self):  # noqa: N802
        if not self._host_ok():
            return self._send(403, b"forbidden", "text/plain")
        url = urlparse(self.path)
        q = parse_qs(url.query)
        ch = (q.get("channel", [""])[0] or "").strip()
        try:
            ch = normalize_channel(ch) if ch else ""
        except ValueError:
            ch = ""
        try:
            if url.path in ("/", "/index.html"):
                return self._send(200, (STATIC / "index.html").read_bytes(), "text/html; charset=utf-8")
            if url.path == "/api/state":
                return self._json(self.dash.state(ch))
            if url.path == "/api/chat":
                return self._json(self.dash.chat(ch))
            if url.path == "/api/shorts":
                return self._json(self.dash.shorts())
            if url.path == "/api/logs":
                raw = q.get("offsets", [None])[0]
                return self._json(self.dash.logs(json.loads(raw) if raw else None))
            m = re.fullmatch(r"/media/([^/]+)/([^/]+)", url.path)
            if m:
                p = self.dash.media_path(unquote(m.group(1)), unquote(m.group(2)))
                return self._serve_file(p) if p else self._send(404, b"not found", "text/plain")
            self._send(404, b"not found", "text/plain")
        except (ConnectionError, BrokenPipeError):
            pass
        except Exception as e:  # noqa: BLE001
            self._json({"error": str(e)}, 500)

    def do_POST(self):  # noqa: N802
        if not self._host_ok():
            return self._send(403, b"forbidden", "text/plain")
        origin = self.headers.get("Origin")
        if origin and urlparse(origin).hostname not in ("127.0.0.1", "localhost", "::1"):
            return self._send(403, b"forbidden", "text/plain")
        try:
            n = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(n) or b"{}") if n else {}
            url = urlparse(self.path).path
            if url == "/api/start":
                ch = normalize_channel(str(body.get("channel", "")))
                self.dash.default_channel = ch
                return self._json({"ok": True, "message": self.dash.runner.start(ch), "channel": ch})
            if url == "/api/stop":
                return self._json({"ok": True, "message": self.dash.runner.stop()})
            if url == "/api/open":
                p = self.dash.media_path(str(body.get("event_id", "")), "short.mp4")
                if p is None:
                    return self._json({"ok": False, "message": "not found"}, 404)
                if os.name == "nt":
                    os.startfile(str(p.parent))  # noqa: S606 - local folder only
                return self._json({"ok": True})
            self._send(404, b"not found", "text/plain")
        except ValueError as e:
            self._json({"ok": False, "message": str(e)}, 400)
        except Exception as e:  # noqa: BLE001
            self._json({"ok": False, "message": str(e)}, 500)


def serve(cfg: Config, config_path: str, port: int = 8765, open_browser: bool = True) -> None:
    dash = Dashboard(cfg, config_path)
    Handler.dash = dash
    httpd = None
    for p in range(port, port + 30):  # another program may already own the default port
        try:
            httpd = ThreadingHTTPServer(("127.0.0.1", p), Handler)
            port = p
            break
        except OSError:
            continue
    if httpd is None:
        raise SystemExit(f"clipwatcher: no free port between {port} and {port + 29}")
    httpd.daemon_threads = True
    url = f"http://127.0.0.1:{port}"
    print(f"Clip Watcher dashboard: {url}  (Ctrl+C to stop; the pipeline keeps running if you started it separately)",
          flush=True)
    if open_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
