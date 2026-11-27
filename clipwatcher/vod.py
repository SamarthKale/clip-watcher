"""Video links and the streamer watch list.

Paste any video link - a finished stream (Twitch, YouTube, Kick), an ordinary upload, a podcast
episode, or anything else yt-dlp can download - and it becomes a recording session like a live one,
so the normal stages (extract -> transcribe -> edit -> library) run unchanged:

  1. `parse_source`  recognises the link; `probe` asks yt-dlp for title, channel, duration, start time
  2. `download`      yt-dlp fetches the video (and, on YouTube, the live-chat replay)
  3. moments         chat replay when there is one (the same detector as live); otherwise the scout
                     (`scout.py`: whole-video transcript + Claude); the loudness detector as a fallback
  4. the strongest `max_shorts` of them are queued exactly as live spikes are

Jobs live in the `vod_jobs` table and are worked by the `vod` stage, one at a time. The watch list
(`watchlist` table) names channels to check for new finished streams; each new VOD that passes the
title filter becomes a job once. Nothing here uploads anything.
"""
from __future__ import annotations

import json
import logging
import re
import subprocess
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from . import media
from .audio_detector import AudioSpikeDetector, per_second
from .chat import chat_log_path
from .config import Config
from .db import DB
from .detector import detect_file
from .signals import audio_scan
from .util import STOP, utc_iso, which

log = logging.getLogger("vod")

PLATFORMS = ("twitch", "youtube", "kick")  # watch-list platforms; any other link is platform "web"
MAX_SHORTS_LIMIT = 20
DEFAULT_MAX_SHORTS = 5


class VodError(Exception):
    """A problem the user can read and act on."""


# ----------------------------------------------------------------- links
def parse_source(url: str) -> dict:
    """{'platform', 'video_id', 'url'} for a video link; VodError otherwise.

    Twitch, YouTube and Kick links get their canonical form (so the same video is never queued
    twice). Any other http(s) link is platform "web": yt-dlp decides whether it can download it,
    and its own video ID is used once the link has been probed (video_id None until then).
    """
    raw = (url or "").strip()
    if re.match(r"^[a-z][a-z0-9+.-]*://", raw, re.I) and not re.match(r"^https?://", raw, re.I):
        raise VodError("Only http(s) links can be added")
    if not re.match(r"^https?://", raw, re.I):
        raw = "https://" + raw
    u = urlparse(raw)
    host = (u.hostname or "").lower().removeprefix("www.").removeprefix("m.")
    if "." not in host or " " in raw.strip():
        raise VodError("That doesn't look like a link")
    parts = [p for p in u.path.split("/") if p]
    if host == "twitch.tv":
        if len(parts) >= 2 and parts[0] == "videos" and parts[1].isdigit():
            return {"platform": "twitch", "video_id": parts[1], "url": f"https://www.twitch.tv/videos/{parts[1]}"}
        if "clip" in parts:
            return _web(u)
        raise VodError("That's a Twitch channel. Paste a finished stream (twitch.tv/videos/<number>) or a clip")
    if host in ("youtube.com", "youtu.be", "music.youtube.com"):
        vid = None
        if host == "youtu.be" and parts:
            vid = parts[0]
        elif parts and parts[0] in ("live", "embed", "v", "shorts") and len(parts) > 1:
            vid = parts[1]
        elif parts and parts[0] == "watch":
            vid = (parse_qs(u.query).get("v") or [None])[0]
        if vid and re.fullmatch(r"[A-Za-z0-9_-]{11}", vid):
            return {"platform": "youtube", "video_id": vid, "url": f"https://www.youtube.com/watch?v={vid}"}
        raise VodError("YouTube links must point to one video (watch?v=..., youtu.be/..., /shorts/... or /live/...)")
    if host == "kick.com":
        vid = None
        if "video" in parts and parts.index("video") + 1 < len(parts):
            vid = parts[parts.index("video") + 1]
        elif "videos" in parts and parts.index("videos") + 1 < len(parts):
            vid = parts[parts.index("videos") + 1]
        if vid and re.fullmatch(r"[A-Za-z0-9-]{8,64}", vid):
            return {"platform": "kick", "video_id": vid, "url": f"https://kick.com/video/{vid}"}
        if "clips" in parts or "clip" in parts:
            return _web(u)
        raise VodError("That's a Kick channel. Paste a past broadcast: kick.com/video/<id>")
    return _web(u)


def _web(u) -> dict:
    """Any other site: kept as typed (minus the #fragment); yt-dlp's own ID is used after probing."""
    return {"platform": "web", "video_id": None, "url": u._replace(fragment="").geturl()}


def clamp_shorts(n) -> int:
    try:
        n = int(n)
    except (TypeError, ValueError):
        return DEFAULT_MAX_SHORTS
    return max(1, min(MAX_SHORTS_LIMIT, n))


def safe_id(text: str) -> str:
    """ASCII id usable in file names and session IDs."""
    return re.sub(r"[^A-Za-z0-9_-]+", "_", text or "").strip("_")[:64] or "video"


def channel_slug(name: str) -> str:
    """Lowercase [a-z0-9_] channel name usable in event IDs (no hyphens: IDs split on the last one)."""
    s = re.sub(r"[^a-z0-9_]+", "_", (name or "").lower().lstrip("@")).strip("_")
    return s[:40] or "unknown"


def channel_link(platform: str, info: dict, slug: str) -> str:
    if platform == "web":
        return info.get("channel_url") or info.get("uploader_url") or info.get("webpage_url") or ""
    if platform == "twitch":
        return f"https://www.twitch.tv/{slug}"
    if platform == "kick":
        return f"https://kick.com/{slug}"
    return info.get("channel_url") or info.get("uploader_url") or f"https://www.youtube.com/@{slug}"


# ---------------------------------------------------------------- yt-dlp
def _ytdlp(cfg: Config) -> str:
    binary = cfg["vod"]["ytdlp"]
    path = which(binary) or (str(cfg.resolve(binary)) if cfg.resolve(binary).exists() else None)
    if not path:
        raise VodError(f"yt-dlp not found ({binary!r}); set vod.ytdlp in config.toml")
    return path


def _run(cmd: list[str], timeout: float) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace",
                          timeout=timeout)


def probe(cfg: Config, url: str, run=_run) -> dict:
    proc = run([_ytdlp(cfg), "-J", "--no-playlist", "--no-warnings", url], 180)
    if proc.returncode != 0:
        raise VodError("yt-dlp could not read that link: " + (proc.stderr or "").strip().splitlines()[-1:][0][:300]
                       if (proc.stderr or "").strip() else "yt-dlp could not read that link")
    try:
        info = json.loads(proc.stdout)
    except ValueError as e:
        raise VodError(f"yt-dlp returned something unreadable: {e}") from e
    if info.get("_type") in ("playlist", "multi_video"):
        raise VodError("That link is a playlist or channel. Paste the link of one video.")
    if info.get("is_live") or info.get("live_status") == "is_live":
        raise VodError("That stream is still live. Watch it live, then add the finished VOD afterwards.")
    if not info.get("duration"):
        raise VodError("That link has no finished video yet (no duration).")
    return info


def download(cfg: Config, url: str, platform: str, dest_dir: Path, stem: str, info: dict,
             run=_run) -> tuple[Path, Path | None]:
    """The video file and, for YouTube, the live-chat replay file (None if there is none)."""
    dest_dir.mkdir(parents=True, exist_ok=True)
    v = cfg["vod"]
    h = int(v["max_height"])
    ffdir = str(Path(cfg["extract"]["ffmpeg"]).parent) if Path(cfg["extract"]["ffmpeg"]).parent.name else None
    out_tpl = str(dest_dir / f"{stem}.%(ext)s")
    cmd = [_ytdlp(cfg), "--no-playlist", "--no-warnings", "--newline", "-f",
           f"bv*[height<={h}]+ba/b[height<={h}]/b", "--merge-output-format", "mp4", "-o", out_tpl]
    if ffdir and ffdir != ".":
        cmd += ["--ffmpeg-location", ffdir]
    proc = run(cmd + [url], float(v["download_timeout"]))
    video = dest_dir / f"{stem}.mp4"
    if proc.returncode != 0 or not video.exists():
        tail = (proc.stderr or proc.stdout or "").strip().splitlines()[-1:] or [""]
        raise VodError("download failed: " + tail[0][:300])
    chat = None
    if platform == "youtube":
        try:
            run(cmd[:1] + ["--no-playlist", "--no-warnings", "--skip-download", "--write-subs", "--sub-langs",
                           "live_chat", "-o", out_tpl, url], 900)
        except (subprocess.TimeoutExpired, OSError) as e:
            log.warning("chat replay download failed: %s", e)
        cand = dest_dir / f"{stem}.live_chat.json"
        chat = cand if cand.exists() else None
    return video, chat


# ------------------------------------------------------------ chat replay
def youtube_chat_to_log(replay: Path, out: Path, start_wall: float, duration: float,
                        heartbeat: float = 5.0) -> int:
    """Write a replay as a chat.log the live detector understands. Returns the message count.

    The detector treats silence longer than gap_seconds as a monitoring gap, so a heartbeat is
    written every few seconds across the whole video, exactly like the live chat reader does.
    """
    records: list[dict] = [{"type": "connect", "t": start_wall, "channel": "replay"}]
    n = 0
    for line in replay.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            d = json.loads(line)
            act = d["replayChatItemAction"]
            off = int(act.get("videoOffsetTimeMsec") or 0) / 1000.0
            for a in act.get("actions", []):
                r = a.get("addChatItemAction", {}).get("item", {}).get("liveChatTextMessageRenderer")
                if not r:
                    continue
                text = "".join(run.get("text") or run.get("emoji", {}).get("shortcuts", [""])[0]
                               for run in r.get("message", {}).get("runs", []))
                if not text.strip() or off < 0 or off > duration:
                    continue
                name = (r.get("authorName") or {}).get("simpleText") or "viewer"
                records.append({"type": "msg", "t": round(start_wall + off, 3), "user": name.lower(),
                                "name": name, "text": text, "id": r.get("id") or f"yt-{n}"})
                n += 1
        except (ValueError, KeyError, TypeError, AttributeError):
            continue
    t = start_wall
    while t < start_wall + duration:
        records.append({"type": "heartbeat", "t": round(t, 3)})
        t += heartbeat
    records.sort(key=lambda r: (r["t"], 0 if r["type"] == "connect" else 1))
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(out.name + ".tmp")
    tmp.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in records) + "\n", encoding="utf-8")
    tmp.replace(out)
    return n


# ----------------------------------------------------------------- spikes
def loud_candidates(cfg: Config, sess, chunk: float = 600.0) -> list[dict]:
    """The loudness detector over a whole video, as candidate moments (strength = LU rise)."""
    a = cfg["detect"]["audio"]
    ff = cfg["extract"]["ffmpeg"]
    chat_offset = float(cfg["sync"]["chat_offset_seconds"])
    det = AudioSpikeDetector(sess["channel"], a, chat_offset)
    rec = Path(sess["path"])
    total = float(sess["end_wall"]) - float(sess["start_wall"])
    offset, evs = 0.0, []
    while offset < total and not STOP.is_set():
        length = min(chunk, total - offset)
        start = max(0.0, offset - 1.0)  # momentary loudness needs a moment of warm-up
        series, _ = audio_scan(ff, rec, start=start, dur=length + (offset - start), timeout=1800)
        for sec, lufs in per_second(series, skip_before=offset - start):
            evs += det.feed(float(sess["start_wall"]) + start + sec, lufs)
        offset += length
    evs += det.flush()
    return [{"event_id": e.event_id, "spike_ts": e.spike_ts, "peak_ts": e.peak_ts, "stats": e.stats,
             "strength": float(e.stats.get("rise_lu") or 0)} for e in evs]


def chat_candidates(cfg: Config, channel: str, chat_log: Path) -> list[dict]:
    """The chat detector over a replay, as candidate moments (strength = peak ratio x size)."""
    return [{"event_id": e.event_id, "spike_ts": e.spike_ts, "peak_ts": e.peak_ts, "stats": e.stats,
             "strength": float(e.stats.get("peak_ratio") or 0) * float(e.stats.get("peak_count") or 1)}
            for e in detect_file(chat_log, channel, cfg["detect"])]


def cap(candidates: list[dict], n: int) -> list[dict]:
    """The n strongest candidates, in video order."""
    best = sorted(candidates, key=lambda c: -float(c.get("strength") or 0))[:max(0, n)]
    return sorted(best, key=lambda c: c["spike_ts"])


def queue_moments(cfg: Config, db: DB, channel: str, candidates: list[dict]) -> int:
    merge = float(cfg["detect"]["merge_window_seconds"])
    return sum(int(db.add_event(c["event_id"], channel, c["spike_ts"], c["peak_ts"], c["stats"],
                                merge_window=merge)) for c in candidates)


# ----------------------------------------------------------------- ingest
def ingest(cfg: Config, db: DB, url: str, run=_run, on_status=lambda s: None,
           max_shorts: int = DEFAULT_MAX_SHORTS) -> dict:
    """Turn one video link into a recording session with up to max_shorts queued moments."""
    src = parse_source(url)
    existing = db.conn.execute("SELECT id FROM sessions WHERE source_url=?", (src["url"],)).fetchone()
    if existing:
        return {"session_id": existing["id"], "events": 0, "already": True}
    on_status("reading link")
    info = probe(cfg, src["url"], run)
    platform = src["platform"]
    video_id = src["video_id"] or safe_id(str(info.get("id") or ""))
    slug = channel_slug(info.get("uploader_id") or info.get("channel") or info.get("uploader")
                        or info.get("extractor_key") or "")
    duration = float(info["duration"])
    start_wall = float(info.get("timestamp") or info.get("release_timestamp") or (time.time() - duration))
    sid = f"{slug}_{platform}_{video_id}"
    on_status("downloading")
    dest = cfg.path("recordings") / slug
    video, chat_replay = download(cfg, src["url"], platform, dest, sid, info, run)
    try:
        real = media.probe(cfg["extract"]["ffprobe"], video)
        duration = float(real.get("format", {}).get("duration") or duration)
    except (media.MediaError, OSError, ValueError):
        pass
    db.add_session(sid, slug, str(video), "vod", kind="vod", source_url=src["url"], platform=platform,
                   channel_url=channel_link(platform, info, slug))
    db.set_session_start(sid, start_wall)
    db.end_session(sid, start_wall + duration)
    sess = db.session(sid)
    n = clamp_shorts(max_shorts)
    used, cands = [], []
    if chat_replay is not None:
        on_status("reading chat replay")
        log_path = cfg.path("chat") / slug / f"{sid}.log"
        msgs = youtube_chat_to_log(chat_replay, log_path, start_wall, duration)
        if msgs >= int(cfg["vod"]["min_chat_messages"]):
            cands = chat_candidates(cfg, slug, log_path)
            used.append("chat")
    if not used and cfg["scout"]["enabled"]:
        from . import scout
        try:
            moments = scout.find_moments(cfg, video, duration, n, on_status=on_status,
                                         title=info.get("title") or "", channel=slug)
        except scout.ScoutError as e:
            log.warning("scout found nothing usable for %s: %s", sid, e)
            moments = []
        if moments:
            cands = scout.to_candidates(moments, slug, start_wall)
            used.append("scout")
    if not used or cfg["vod"]["audio_always"]:
        on_status("listening for loud moments")
        cands += loud_candidates(cfg, sess)
        used.append("audio")
    events = queue_moments(cfg, db, slug, cap(cands, n))
    db.kv_set(f"vod:{sid}", {"url": src["url"], "title": info.get("title"), "detectors": used,
                             "events": events, "duration": duration, "max_shorts": n,
                             "done": utc_iso(time.time())})
    log.info("video %s: %s, %.0f min, %d moment(s) from %s", sid, (info.get("title") or "")[:60],
             duration / 60, events, "+".join(used))
    return {"session_id": sid, "events": events, "detectors": used, "title": info.get("title")}


# ------------------------------------------------------------------ queue
def add_job(db: DB, url: str, source: str = "manual",
            max_shorts: int = DEFAULT_MAX_SHORTS) -> tuple[int, bool]:
    """Queue a link. Returns (job id, newly queued). The same link is never queued twice."""
    src = parse_source(url)
    row = db.conn.execute("SELECT id FROM vod_jobs WHERE url=?", (src["url"],)).fetchone()
    if row:
        return row["id"], False
    cur = db.conn.execute("INSERT INTO vod_jobs(url, platform, status, source, max_shorts, created, updated) "
                          "VALUES(?, ?, 'pending', ?, ?, ?, ?)",
                          (src["url"], src["platform"], source, clamp_shorts(max_shorts), time.time(), time.time()))
    return cur.lastrowid, True


def work_one(cfg: Config, db: DB, run=_run) -> bool:
    """Run the oldest pending job. Returns False when there was nothing to do."""
    with db.tx() as c:
        row = c.execute("SELECT * FROM vod_jobs WHERE status='pending' ORDER BY id LIMIT 1").fetchone()
        if row is None:
            return False
        c.execute("UPDATE vod_jobs SET status='running', attempts=attempts+1, updated=? WHERE id=?",
                  (time.time(), row["id"]))

    def status(text: str) -> None:
        db.conn.execute("UPDATE vod_jobs SET note=?, updated=? WHERE id=?", (text, time.time(), row["id"]))
    try:
        res = ingest(cfg, db, row["url"], run, status, max_shorts=row["max_shorts"])
        db.conn.execute("UPDATE vod_jobs SET status='done', session_id=?, events=?, note=?, error=NULL, updated=? "
                        "WHERE id=?", (res["session_id"], res.get("events", 0),
                                       res.get("title") or "already added", time.time(), row["id"]))
    except (VodError, subprocess.TimeoutExpired, media.MediaError, OSError) as e:
        retry = isinstance(e, (subprocess.TimeoutExpired, OSError)) and row["attempts"] < 2
        db.conn.execute("UPDATE vod_jobs SET status=?, error=?, updated=? WHERE id=?",
                        ("pending" if retry else "failed", str(e)[:500] or type(e).__name__, time.time(), row["id"]))
        log.warning("VOD job %s %s: %s", row["id"], "will retry" if retry else "failed", e)
    return True


# -------------------------------------------------------------- watch list
def listing_url(platform: str, channel: str) -> str:
    if platform == "twitch":
        return f"https://www.twitch.tv/{channel}/videos?filter=archives&sort=time"
    if platform == "youtube":
        return f"https://www.youtube.com/@{channel.lstrip('@')}/streams"
    if platform == "kick":
        return f"https://kick.com/{channel}/videos"
    raise VodError(f"unknown platform {platform!r}")


def add_watch(db: DB, platform: str, channel: str, keyword: str = "", lookback_hours: int = 36) -> None:
    if platform not in PLATFORMS:
        raise VodError(f"platform must be one of {', '.join(PLATFORMS)}")
    ch = re.sub(r"[^A-Za-z0-9_.@-]", "", channel or "")
    if not ch:
        raise VodError("channel name is empty or has unsupported characters")
    db.conn.execute(
        "INSERT INTO watchlist(platform, channel, keyword, lookback_hours, enabled, created) VALUES(?,?,?,?,1,?) "
        "ON CONFLICT(platform, channel) DO UPDATE SET keyword=excluded.keyword, "
        "lookback_hours=excluded.lookback_hours, enabled=1",
        (platform, ch, (keyword or "").strip(), max(1, int(lookback_hours)), time.time()))


def remove_watch(db: DB, platform: str, channel: str) -> int:
    return db.conn.execute("DELETE FROM watchlist WHERE platform=? AND channel=?", (platform, channel)).rowcount


def recent_entries(cfg: Config, platform: str, channel: str, run=_run, limit: int = 12) -> list[dict]:
    proc = run([_ytdlp(cfg), "-J", "--flat-playlist", "--playlist-end", str(limit), "--no-warnings",
                listing_url(platform, channel)], 180)
    if proc.returncode != 0:
        raise VodError("could not list recent streams: " + ((proc.stderr or "").strip().splitlines() or [""])[-1][:300])
    try:
        entries = json.loads(proc.stdout).get("entries") or []
    except ValueError as e:
        raise VodError(f"unreadable listing: {e}") from e
    return [e for e in entries if isinstance(e, dict) and (e.get("url") or e.get("id"))]


def watch_pass(cfg: Config, db: DB, run=_run, now: float | None = None) -> dict:
    """Check every watched channel once; queue new finished streams that pass the title filter."""
    now = now or time.time()
    queued, skipped, errors = 0, 0, []
    for w in db.conn.execute("SELECT * FROM watchlist WHERE enabled=1").fetchall():
        try:
            entries = recent_entries(cfg, w["platform"], w["channel"], run)
        except VodError as e:
            errors.append(f"{w['platform']}:{w['channel']}: {e}")
            continue
        for e in entries:
            url = e.get("url") or ""
            if not url.startswith("http"):
                url = f"https://www.youtube.com/watch?v={e['id']}" if w["platform"] == "youtube" else \
                      f"https://www.twitch.tv/videos/{e['id']}"
            try:
                src = parse_source(url)
            except VodError:
                continue
            if db.conn.execute("SELECT 1 FROM vod_jobs WHERE url=?", (src["url"],)).fetchone() or \
                    db.conn.execute("SELECT 1 FROM sessions WHERE source_url=?", (src["url"],)).fetchone():
                continue
            title = (e.get("title") or "").lower()
            ts = e.get("timestamp") or e.get("release_timestamp")
            live = bool(e.get("is_live")) or e.get("live_status") in ("is_live", "is_upcoming")
            title_ok = not w["keyword"] or w["keyword"].lower() in title
            if ts is None and title_ok and not live:
                # Flat listings often carry no date (Twitch). Ask about this one video, once.
                try:
                    detail = probe(cfg, src["url"], run)
                    ts = detail.get("timestamp") or detail.get("release_timestamp")
                except VodError:
                    live = True  # still live, or not a finished video yet
            too_old = ts is not None and now - float(ts) > w["lookback_hours"] * 3600
            if not title_ok or too_old or live:
                db.conn.execute("INSERT OR IGNORE INTO vod_jobs(url, platform, status, source, note, created, updated) "
                                "VALUES(?,?,'filtered','watch',?,?,?)",
                                (src["url"], src["platform"], (e.get("title") or "")[:200], now, now))
                skipped += 1
                continue
            _, new = add_job(db, src["url"], source=f"watch:{w['platform']}:{w['channel']}")
            queued += int(new)
        db.conn.execute("UPDATE watchlist SET last_checked=? WHERE id=?", (now, w["id"]))
    return {"queued": queued, "filtered": skipped, "errors": errors}


def vod_forever(cfg: Config, db: DB) -> None:
    """The `vod` stage: work queued links one at a time and check the watch list on a timer."""
    every = float(cfg["vod"]["watch_interval_minutes"]) * 60
    last = 0.0
    # This stage is the only worker of vod_jobs: a job left 'running' was cut off (app closed, crash).
    n = db.conn.execute("UPDATE vod_jobs SET status='pending', updated=? WHERE status='running'",
                        (time.time(),)).rowcount
    if n:
        log.info("picking up %d video link(s) that were interrupted", n)
    log.info("vod worker ready (watch list checked every %.0f min)", every / 60)
    while not STOP.is_set():
        if time.time() - last >= every:
            last = time.time()
            try:
                r = watch_pass(cfg, db)
                if r["queued"] or r["errors"]:
                    log.info("watch list: %d new stream(s) queued, %d filtered, %d problem(s)",
                             r["queued"], r["filtered"], len(r["errors"]))
                for e in r["errors"]:
                    log.warning("watch list: %s", e)
            except (VodError, OSError) as e:
                log.warning("watch list check failed: %s", e)
        if not work_one(cfg, db):
            STOP.wait(5)
