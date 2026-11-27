"""Shorts library: the publish-ready layout the uploader reads.

    <library>/<date>/<channel>__<kind>/
        01_slug.mp4            the finished Short (a verified copy, the edit folder keeps its own)
        01_slug_cover.jpg      9:16 cover
        01_slug_thumb.jpg      16:9 thumbnail
        clips.json             one entry per Short: SEO text, per-platform captions, source, usage
        POST.md                the same, readable

`kind` is `live` for a recorded stream and `vod` for a VOD link. Numbers are given once per event
and never change. clips.json and POST.md are rewritten atomically from clips.json, so a rerun
(or a backfill of older Shorts) never duplicates an entry.
"""
from __future__ import annotations

import json
import logging
import os
import re
import shutil
import time
import unicodedata
from pathlib import Path

from .config import Config
from .db import DB
from .util import read_json, utc_iso

log = logging.getLogger("library")

SCHEMA = 2
TITLE_MAX = 100          # YouTube title limit
DESCRIPTION_MAX = 4500   # YouTube allows 5000 bytes; keep room for the uploader's additions
TAGS_MAX_CHARS = 500     # YouTube tags limit (all tags together)
CAPTION_MAX = {"tiktok": 2200, "shorts": 300, "reels": 2200}
HOOK_MAX = 60


# ------------------------------------------------------------------ paths
def library_root(cfg: Config) -> Path:
    d = cfg.raw.get("library", {}).get("dir") or "Shorts"
    p = Path(d)
    return p if p.is_absolute() else cfg.root / p


def slugify(text: str, max_len: int = 50) -> str:
    """ASCII file-name slug. Devanagari and emoji are dropped; never empty."""
    t = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode("ascii").lower()
    t = re.sub(r"[^a-z0-9]+", "-", t).strip("-")
    if len(t) > max_len:
        t = t[:max_len].rsplit("-", 1)[0] or t[:max_len]
    return t.strip("-") or "clip"


def stream_folder(cfg: Config, channel: str, date: str, kind: str) -> Path:
    if not re.fullmatch(r"[a-z0-9_]+", channel or ""):
        raise ValueError(f"bad channel name {channel!r}")
    if kind not in ("live", "vod"):
        raise ValueError(f"bad kind {kind!r}")
    return library_root(cfg) / date / f"{channel}__{kind}"


# -------------------------------------------------------------- SEO block
def seo_problems(seo: object, channel_url: str) -> list[str]:
    """What is wrong with an edit's `seo` block (empty list = fine)."""
    if not isinstance(seo, dict):
        return ["edit_decisions.json needs an \"seo\" object (title, description, hashtags, tags, "
                "keywords, hook_text, captions)"]
    p: list[str] = []
    title = seo.get("title")
    if not isinstance(title, str) or not title.strip():
        p.append("seo.title is missing")
    elif len(title) > TITLE_MAX:
        p.append(f"seo.title is {len(title)} characters; YouTube allows {TITLE_MAX}")
    elif re.search(r"https?://", title):
        p.append("seo.title must not contain a link")
    desc = seo.get("description")
    if not isinstance(desc, str) or len(desc.strip()) < 80:
        p.append("seo.description must be at least 80 characters (hook, context, credit)")
    else:
        if len(desc) > DESCRIPTION_MAX:
            p.append(f"seo.description is {len(desc)} characters; keep it under {DESCRIPTION_MAX}")
        host = channel_url.split("//", 1)[-1]
        if host not in desc:
            p.append(f"seo.description must credit the streamer with {channel_url}")
    tags = seo.get("hashtags")
    if not isinstance(tags, list) or not 3 <= len(tags) <= 8:
        p.append("seo.hashtags must be a list of 3 to 8 hashtags")
    else:
        for h in tags:
            if not isinstance(h, str) or not re.fullmatch(r"#[^\s#]{2,40}", h):
                p.append(f"seo.hashtags entry {h!r} must look like #word (no spaces)")
        if len({str(h).lower() for h in tags}) != len(tags):
            p.append("seo.hashtags has duplicates")
    yt_tags = seo.get("tags", [])
    if not isinstance(yt_tags, list) or not all(isinstance(t, str) and t.strip() for t in yt_tags):
        p.append("seo.tags must be a list of words or phrases")
    elif sum(len(t) + (2 if " " in t else 0) for t in yt_tags) + max(0, len(yt_tags) - 1) > TAGS_MAX_CHARS:
        p.append(f"seo.tags are longer than YouTube's {TAGS_MAX_CHARS} characters")
    kw = seo.get("keywords", [])
    if not isinstance(kw, list) or not kw:
        p.append("seo.keywords must list the 3-8 search phrases the title and description target")
    hook = seo.get("hook_text")
    if not isinstance(hook, str) or not hook.strip() or len(hook) > HOOK_MAX:
        p.append(f"seo.hook_text must be 1-{HOOK_MAX} characters")
    caps = seo.get("captions")
    if not isinstance(caps, dict):
        p.append("seo.captions must have tiktok, shorts and reels")
    else:
        for k, mx in CAPTION_MAX.items():
            v = caps.get(k)
            if not isinstance(v, str) or not v.strip():
                p.append(f"seo.captions.{k} is missing")
            elif len(v) > mx:
                p.append(f"seo.captions.{k} is {len(v)} characters; limit {mx}")
    return p


def description_txt(seo: dict) -> str:
    """The description.txt the edit step has always written, rendered from the seo block."""
    tags = " ".join(seo.get("hashtags") or [])
    lines = ["Title options:", "1. " + seo["title"], "", "Description:", seo["description"], "",
             "Hashtags: " + tags, ""]
    return "\n".join(lines)


def seo_from_description_txt(text: str, channel_url: str, fallback_title: str) -> dict:
    """Best-effort SEO block for Shorts finished before the seo block existed."""
    m = re.search(r"^1\.\s*(.+)$", text, re.M)
    title = (m.group(1).strip().strip('"') if m else fallback_title)[:TITLE_MAX]
    body = text.split("Description:", 1)[1] if "Description:" in text else text
    body = re.split(r"^\s*(Audio:|Hashtags?:)", body, maxsplit=1, flags=re.M)[0].strip()
    if channel_url.split("//", 1)[-1] not in body:
        body = (body + f"\n\nStreamer: {channel_url}").strip()
    hashtags = list(dict.fromkeys(re.findall(r"#[^\s#,]{2,40}", text)))[:8]
    return {"title": title, "description": body[:DESCRIPTION_MAX], "hashtags": hashtags, "tags": [],
            "keywords": [], "hook_text": title[:HOOK_MAX],
            "captions": {"tiktok": title, "shorts": title, "reels": title}, "derived": True}


# ------------------------------------------------------------ clips.json
def _load(folder: Path) -> dict:
    p = folder / "clips.json"
    if p.exists():
        try:
            doc = json.loads(p.read_text(encoding="utf-8"))
            if isinstance(doc, dict) and isinstance(doc.get("clips"), list):
                return doc
        except ValueError:
            bad = p.with_name(f"clips.corrupt-{int(time.time())}.json")
            os.replace(p, bad)
            log.warning("clips.json in %s was unreadable; kept it as %s", folder, bad.name)
    return {"schema": SCHEMA, "stream": {}, "clips": []}


def _atomic_write(path: Path, text: str) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8", newline="\n")
    os.replace(tmp, path)


def _copy_if_changed(src: Path, dst: Path) -> None:
    if dst.exists() and dst.stat().st_size == src.stat().st_size and dst.stat().st_mtime >= src.stat().st_mtime:
        return
    tmp = dst.with_name(dst.name + ".partial")
    shutil.copy2(src, tmp)
    if tmp.stat().st_size != src.stat().st_size:
        tmp.unlink(missing_ok=True)
        raise OSError(f"copy of {src} came out the wrong size")
    os.replace(tmp, dst)


def render_post_md(doc: dict) -> str:
    s = doc.get("stream", {})
    out = [f"# {s.get('name', '')}: {s.get('title', '')}".rstrip(": "), ""]
    if s.get("url"):
        out += [f"Stream: {s['url']}", ""]
    out += [f"{len(doc['clips'])} Short(s)", ""]
    for c in doc["clips"]:
        caps = c.get("captions", {})
        out += [f"## {c['file']}",
                f"**{c.get('hook_text', '')}** · {c.get('kind', '')} · {c.get('duration', 0):.0f} s"
                + (f" · score {c['score']}" if c.get("score") is not None else ""), "",
                f"**Title:** {c.get('post_title', '')}", "",
                "**Description:**", c.get("description", ""), "",
                f"**Hashtags:** {' '.join(c.get('hashtags', []))}", ""]
        if c.get("tags"):
            out += [f"**Tags:** {', '.join(c['tags'])}", ""]
        for k in ("tiktok", "shorts", "reels"):
            if caps.get(k):
                out += [f"**{k.capitalize() if k != 'tiktok' else 'TikTok'}:** {caps[k]}", ""]
        src = c.get("source", {})
        out += [f"_Why: {c.get('reason', '')}_",
                f"_From the stream at {src.get('recording_start', '')} ({c.get('event_id', '')})_", ""]
    return "\n".join(out).rstrip() + "\n"


# --------------------------------------------------------------- publish
def publish(cfg: Config, db, event_id: str) -> Path | None:
    """Copy a finished Short into the library and update its folder's clips.json / POST.md.

    Idempotent: the same event keeps its number and file name. Returns the library video path,
    or None when the Short has no finished output (rejected / failed edits are not published).
    """
    from .editor import short_dir
    from .storage import event_date, parse_event_id

    sdir = short_dir(cfg, event_id)
    short = sdir / "short.mp4"
    meta_path = sdir / "metadata.json"
    if not short.exists() or not meta_path.exists():
        return None
    meta = read_json(meta_path)
    dec = {}
    if (sdir / "edit_decisions.json").exists():
        try:
            dec = read_json(sdir / "edit_decisions.json")
        except ValueError:
            dec = {}
    att = meta["attribution"]
    channel, ts = parse_event_id(event_id)
    session_id = meta.get("recording_session") or ""
    kind = "live"
    if session_id:
        own = db is None
        d = DB(cfg.path("db")) if own else db
        try:
            row = d.session(session_id)
            if row is not None and "kind" in row.keys() and row["kind"]:
                kind = row["kind"]
        finally:
            if own:
                d.close()
    seo = dec.get("seo") if isinstance(dec.get("seo"), dict) else None
    if seo is None:
        txt = (sdir / "description.txt").read_text("utf-8", "replace") if (sdir / "description.txt").exists() else ""
        seo = seo_from_description_txt(txt, att["channel_url"], dec.get("logline") or event_id)

    folder = stream_folder(cfg, channel, event_date(ts), kind)
    folder.mkdir(parents=True, exist_ok=True)
    doc = _load(folder)
    doc["schema"] = SCHEMA
    doc["stream"] = {"name": att.get("streamer", channel), "platform": att.get("platform", "twitch"),
                     "url": att["channel_url"], "kind": kind,
                     "title": f"{att.get('streamer', channel)} {kind}",
                     "sessions": sorted({*doc.get("stream", {}).get("sessions", []), session_id} - {""})}
    existing = next((c for c in doc["clips"] if c.get("event_id") == event_id), None)
    if existing:
        stem = Path(existing["file"]).stem
    else:
        used = [int(m.group(1)) for c in doc["clips"] if (m := re.match(r"(\d+)_", c.get("file", "")))]
        stem = f"{(max(used) + 1) if used else 1:02d}_{slugify(seo['title'])}"

    video = folder / f"{stem}.mp4"
    _copy_if_changed(short, video)
    cover = thumb = None
    for name, suffix in (("cover.jpg", "_cover.jpg"), ("thumbnail.jpg", "_thumb.jpg")):
        src = sdir / "final" / name
        if src.exists():
            _copy_if_changed(src, folder / f"{stem}{suffix}")
            if suffix == "_cover.jpg":
                cover = f"{stem}{suffix}"
            else:
                thumb = f"{stem}{suffix}"

    short_info = meta.get("short") or {}
    spike = meta.get("spike") or {}
    st = spike.get("stats") or {}
    score = meta.get("highlight_score")
    if isinstance(score, dict):
        score = score.get("total")
    src = meta.get("source_clip") or {}
    caps = seo.get("captions") or {}
    entry = {
        "file": video.name, "cover": cover, "thumbnail": thumb, "kind": kind, "event_id": event_id,
        "post_title": seo["title"], "description": seo["description"],
        "hashtags": list(seo.get("hashtags") or []), "tags": list(seo.get("tags") or []),
        "keywords": list(seo.get("keywords") or []),
        "hook_text": seo.get("hook_text") or seo["title"][:HOOK_MAX],
        "hooks": [seo.get("hook_text") or seo["title"][:HOOK_MAX]],
        "caption": caps.get("shorts") or seo["title"],
        "captions": {k: caps.get(k) or seo["title"] for k in ("tiktok", "shorts", "reels")},
        "language": seo.get("language") or dec.get("language") or "en",
        "score": score, "moment_type": meta.get("moment_type"),
        "reason": (f"chat spike {st.get('first_ratio')}x ({st.get('first_count')} msgs vs "
                   f"{st.get('baseline')})" if st.get("first_ratio") else "spike"),
        "duration": round(float(short_info.get("duration") or 0), 1),
        "stream_start": src.get("source_start_s"), "stream_end": src.get("source_end_s"),
        "spike": {"source": (meta.get("detection") or {}).get("source", "chat"),
                  "utc": spike.get("spike_utc"), "messages": st.get("first_count"),
                  "baseline": st.get("baseline"), "ratio": st.get("first_ratio")},
        "source": {"session": session_id, "recording_start": src.get("source_start"),
                   "recording_end": src.get("source_end"), "start_utc": src.get("source_start_utc"),
                   "end_utc": src.get("source_end_utc")},
        "attribution": {"streamer": att.get("streamer"), "channel_url": att["channel_url"],
                        "credit_line": att.get("credit_line")},
        "usage": _usage(cfg, event_id),
        "seo_derived": bool(seo.get("derived")),
        "published_to_library_utc": (existing or {}).get("published_to_library_utc") or utc_iso(time.time()),
    }
    if existing:
        doc["clips"][doc["clips"].index(existing)] = entry
    else:
        doc["clips"].append(entry)
    doc["clips"].sort(key=lambda c: c["file"])
    _atomic_write(folder / "clips.json", json.dumps(doc, ensure_ascii=False, indent=2) + "\n")
    _atomic_write(folder / "POST.md", render_post_md(doc))
    log.info("library: %s -> %s", event_id, video)
    return video


def _usage(cfg: Config, event_id: str) -> dict | None:
    """Claude usage for this Short (all attempts), if the usage module recorded it."""
    try:
        from .usage import usage_for_event
        return usage_for_event(cfg, event_id)
    except ImportError:
        return None


def backfill(cfg: Config, db) -> list[Path]:
    """Publish every finished Short that is not in the library yet (older Shorts, reruns)."""
    out = []
    rows = db.conn.execute("SELECT event_id FROM jobs WHERE stage='edit' AND status='done'").fetchall()
    for r in rows:
        try:
            p = publish(cfg, db, r["event_id"])
            if p:
                out.append(p)
        except (OSError, ValueError, KeyError) as e:
            log.warning("library backfill %s failed: %s", r["event_id"], e)
    return out
