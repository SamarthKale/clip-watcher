"""STEP 9 - Storage: verified backups and safe cleanup.

Layout
  Raw Cut Clips (external drive)  <raw_clips_dir>/<streamer>/<YYYY-MM-DD>/<event>/
      clip.mp4, metadata.json, transcripts, words.json, chat_context.json, frames/, checksums.sha256
  Edited Clips (internal drive)   <edited_dir>/<streamer>/<YYYY-MM-DD>/<event>/
      short.mp4, edit_decisions.json, description.txt, metadata.json, edit_log.json
  Recordings with no clips        <recordings_archive_dir>/<streamer>/<session>.ts  (kept)

Everything is produced on the internal drive first. Per event, once its edit is
finished (done / rejected / failed):
  1. the raw clip and the edited Short are fully decoded to prove they are complete
  2. the raw-clip folder is copied to the external drive under a .partial name,
     every file SHA-256-verified on both sides, the copy decoded again, then renamed
  3. only then are the local staging copy and temporary files removed

Per recording session (the janitor):
  * a recording is deleted only when its stream has ended (plus a settle time),
    every event in it was extracted, and every raw clip is verified on the
    external drive. A failed extraction keeps the recording forever (fix + retry).
  * a recording with no clips is moved (verified) to the external drive and kept
  * when the internal drive runs low, ended recordings that still have work
    pending are moved (verified) to the external drive and extraction continues
    from there

Nothing is ever deleted unless a verified copy exists or every clip it was
needed for has been verified and backed up. If the external drive is missing,
work waits; nothing is lost.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import shutil
import stat
import sys
import time
from datetime import datetime
from pathlib import Path

from . import media
from .config import Config
from .db import DB
from .util import STOP, read_json, utc_iso, write_json
from .worker import Defer, Done, Skip

log = logging.getLogger("storage")

TERMINAL_EDIT = ("done", "rejected", "failed", "skipped")
CHUNK = 8 * 1024 * 1024


# ------------------------------------------------------------------ paths
def _dir(cfg: Config, key: str) -> Path | None:
    v = cfg["storage"].get(key) or ""
    if not v:
        return None
    p = Path(v)
    return p if p.is_absolute() else cfg.root / p


def raw_archive_root(cfg: Config) -> Path | None:
    return _dir(cfg, "raw_clips_dir")


def recordings_archive_root(cfg: Config) -> Path | None:
    return _dir(cfg, "recordings_archive_dir")


def edited_root(cfg: Config) -> Path:
    return _dir(cfg, "edited_dir") or cfg.path("shorts")


def event_date(spike_ts: float) -> str:
    return datetime.fromtimestamp(spike_ts).strftime("%Y-%m-%d")


def parse_event_id(event_id: str) -> tuple[str, float]:
    channel, _, ts = event_id.rpartition("-")
    return channel, float(ts)


def library_subpath(event_id: str) -> Path:
    channel, ts = parse_event_id(event_id)
    return Path(channel) / event_date(ts) / event_id


# --------------------------------------------------------------- helpers
def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        while chunk := fh.read(CHUNK):
            h.update(chunk)
    return h.hexdigest()


def _copy_hashed(src: Path, dst: Path) -> str:
    """Copy src -> dst, returning the SHA-256 of the bytes read from src."""
    h = hashlib.sha256()
    dst.parent.mkdir(parents=True, exist_ok=True)
    with open(src, "rb") as fi, open(dst, "wb") as fo:
        while chunk := fi.read(CHUNK):
            h.update(chunk)
            fo.write(chunk)
        fo.flush()
        os.fsync(fo.fileno())
    return h.hexdigest()


def _make_writable(path: Path) -> None:
    try:
        os.chmod(path, stat.S_IREAD | stat.S_IWRITE)
    except OSError:
        pass


def _rmtree(path: Path) -> None:
    def onerror(func, p, exc):  # read-only files on Windows
        _make_writable(Path(p))
        func(p)
    if sys.version_info >= (3, 12):
        shutil.rmtree(path, onexc=onerror)
    else:
        shutil.rmtree(path, onerror=lambda f, p, e: onerror(f, p, e))


def _unlink(path: Path) -> None:
    _make_writable(path)
    path.unlink()


def _merge_into(src: Path, dst: Path) -> None:
    """Move files from an old-layout folder into dst (existing files in dst win), then drop src."""
    for f in sorted(p for p in src.rglob("*") if p.is_file()):
        target = dst / f.relative_to(src)
        if not target.exists():
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(f), str(target))
    _rmtree(src)


def _prune_empty_parents(folder: Path, stop: Path) -> None:
    try:
        while folder != stop and folder.is_relative_to(stop) and not any(folder.iterdir()):
            folder.rmdir()
            folder = folder.parent
    except OSError:
        pass


def drive_ready(root: Path | None, need_bytes: int = 0) -> tuple[bool, str]:
    if root is None:
        return False, "no archive folder configured"
    anchor = Path(root.anchor or root)
    if not anchor.exists():
        return False, f"drive {anchor} is not connected"
    try:
        root.mkdir(parents=True, exist_ok=True)
        probe = root / ".clipwatcher-write-test"
        probe.write_bytes(b"ok")
        probe.unlink()
    except OSError as e:
        return False, f"cannot write to {root}: {e}"
    free = shutil.disk_usage(root).free
    if free < need_bytes * 1.05 + 1e9:
        return False, f"not enough space on {anchor} ({free / 1e9:.1f} GB free)"
    return True, "ok"


def copy_tree_verified(src: Path, dst: Path) -> dict[str, str]:
    """Copy a folder to dst via dst.partial, verifying every file's SHA-256 on both sides.

    Returns {relative path: sha256}. dst only appears once everything verified.
    """
    partial = dst.with_name(dst.name + ".partial")
    if partial.exists():
        _rmtree(partial)
    sums: dict[str, str] = {}
    for f in sorted(p for p in src.rglob("*") if p.is_file()):
        rel = f.relative_to(src).as_posix()
        src_hash = _copy_hashed(f, partial / rel)
        dst_hash = sha256_file(partial / rel)
        if src_hash != dst_hash:
            raise IOError(f"checksum mismatch copying {rel}")
        sums[rel] = src_hash
    (partial / "checksums.sha256").write_text(
        "".join(f"{h}  {rel}\n" for rel, h in sums.items()), encoding="utf-8")
    if dst.exists():
        old = read_checksums(dst)
        if old != sums:
            raise IOError(f"{dst} already exists with different contents; refusing to overwrite")
        _rmtree(partial)
    else:
        os.replace(partial, dst)
    return sums


def read_checksums(folder: Path) -> dict[str, str]:
    f = folder / "checksums.sha256"
    if not f.exists():
        return {}
    out = {}
    for line in f.read_text(encoding="utf-8").splitlines():
        h, _, rel = line.partition("  ")
        if rel:
            out[rel] = h
    return out


def verify_tree(folder: Path) -> list[str]:
    """Re-hash an archived folder against its checksums.sha256. Returns problems."""
    sums = read_checksums(folder)
    if not sums:
        return [f"{folder} has no checksums.sha256"]
    bad = []
    for rel, h in sums.items():
        p = folder / rel
        if not p.exists():
            bad.append(f"missing {rel}")
        elif sha256_file(p) != h:
            bad.append(f"checksum mismatch {rel}")
    return bad


def move_file_verified(src: Path, dst: Path) -> str:
    """Move a (large) file across drives: copy, verify both sides, then delete src."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    partial = dst.with_name(dst.name + ".partial")
    src_hash = _copy_hashed(src, partial)
    if sha256_file(partial) != src_hash:
        _unlink(partial)
        raise IOError(f"checksum mismatch moving {src}")
    os.replace(partial, dst)
    (dst.with_name(dst.name + ".sha256")).write_text(f"{src_hash}  {dst.name}\n", encoding="utf-8")
    _unlink(src)
    return src_hash


# ------------------------------------------------------- per-event archive
def handle_archive(cfg: Config, db: DB, job) -> Done | Defer | Skip:
    from .editor import job_dir, legacy_short_dir, short_dir
    from .extractor import local_clip_dir

    event_id = job["event_id"]
    ff, fp = cfg["extract"]["ffmpeg"], cfg["extract"]["ffprobe"]
    local = local_clip_dir(cfg, event_id)
    root = raw_archive_root(cfg)
    dest = root / library_subpath(event_id) if root else None
    edit = db.job(event_id, "edit")
    edit_status = edit["status"] if edit else None

    # Edited clip: lives on the internal drive. Bring any legacy-location output over.
    sdir = short_dir(cfg, event_id)
    legacy = legacy_short_dir(cfg, event_id)
    if legacy.exists() and legacy != sdir:
        _merge_into(legacy, sdir)
    edited_ok = None
    if edit_status == "done":
        media.verify_playable(ff, fp, sdir / "short.mp4")  # raises if broken -> retried, nothing deleted
        edited_ok = True

    if not local.exists():
        if dest and dest.exists() and not verify_tree(dest):
            return Done({"raw": str(dest)}, note="already archived")
        return Skip("raw clip is missing locally and not archived")

    media.verify_playable(ff, fp, local / "clip.mp4")

    # Edited Clips holds finished Shorts only. For a rejected or failed edit, the
    # editor's reasoning travels with the raw clip instead.
    if edit_status in ("rejected", "failed", "skipped"):
        note = {"edit_status": edit_status, "recorded_utc": utc_iso(time.time())}
        if (sdir / "edit_decisions.json").exists():
            try:
                note["edit_decisions"] = read_json(sdir / "edit_decisions.json")
            except ValueError:
                pass
        if edit and edit["last_error"]:
            note["last_error"] = edit["last_error"][-2000:]
        write_json(local / "editor_outcome.json", note)

    if dest is None:
        return Done({"raw": str(local)}, note="no external archive configured; kept locally")
    size = sum(p.stat().st_size for p in local.rglob("*") if p.is_file())
    ok, why = drive_ready(root, size)
    if not ok:
        return Defer(time.time() + cfg["storage"]["retry_minutes"] * 60, f"waiting for external drive: {why}")

    sums = copy_tree_verified(local, dest)
    media.verify_playable(ff, fp, dest / "clip.mp4")  # the backup itself must play
    problems = verify_tree(dest)
    if problems:
        raise IOError(f"backup verification failed: {problems}")

    # Point the edited clip's metadata at the archived raw clip.
    meta_path = sdir / "metadata.json"
    if meta_path.exists():
        meta = read_json(meta_path)
        meta["raw_clip"] = str(dest / "clip.mp4")
        meta["raw_clip_sha256"] = sums.get("clip.mp4")
        write_json(meta_path, meta)

    # Temporary files: editor work folder and the job package (its run log is kept).
    jdir = job_dir(cfg, event_id)
    if sdir.exists() and (jdir / "claude_run.json").exists():
        shutil.copy2(jdir / "claude_run.json", sdir / "edit_log.json")
    if (sdir / "work").exists() and edit_status in ("done", "rejected"):
        _rmtree(sdir / "work")
    if sdir.exists() and edit_status in ("rejected", "failed", "skipped") and not (sdir / "short.mp4").exists():
        _rmtree(sdir)  # its notes were archived with the raw clip (editor_outcome.json)
        _prune_empty_parents(sdir.parent, edited_root(cfg))
    if jdir.exists() and edit_status in ("done", "rejected"):
        _rmtree(jdir)

    _rmtree(local)  # verified copy exists on the external drive
    db.log_storage("archive_raw", event_id, str(local), str(dest), sums.get("clip.mp4"))
    log.info("archived %s -> %s (%d files verified)%s", event_id, dest, len(sums),
             "" if edited_ok else f" [edit {edit_status}]")
    return Done({"raw": str(dest), "files": len(sums), "edited_verified": bool(edited_ok)})


# ------------------------------------------------------------- janitor
def _events_in_session(db: DB, sess, chat_offset: float) -> list:
    end = sess["end_wall"] or time.time()
    return db.conn.execute(
        "SELECT * FROM events WHERE channel=? AND spike_ts + ? >= ? AND spike_ts + ? <= ?",
        (sess["channel"], chat_offset, sess["start_wall"], chat_offset, end)).fetchall()


def session_state(cfg: Config, db: DB, sess) -> tuple[str, str]:
    """Decide what may happen to an ended session's recording.

    Returns (action, reason) with action in: wait, hold, delete, archive_clipless.
    """
    st = cfg["storage"]
    if time.time() - (sess["end_wall"] or 0) < st["settle_minutes"] * 60:
        return "wait", "stream ended recently; detection/extraction may still be running"
    events = _events_in_session(db, sess, float(cfg["sync"]["chat_offset_seconds"]))
    clipped = 0
    for ev in events:
        ex = db.job(ev["id"], "extract")
        status = ex["status"] if ex else "pending"
        if status in ("pending", "running"):
            return "wait", f"{ev['id']} not extracted yet"
        if status == "failed":
            return "hold", f"extraction of {ev['id']} failed - fix and `retry`, recording kept"
        if status == "skipped":
            continue
        clipped += 1
        ar = db.job(ev["id"], "archive")
        if ar is None or ar["status"] != "done":
            return "wait", f"{ev['id']} raw clip not backed up yet"
        dest = raw_archive_root(cfg)
        if dest is not None:
            folder = dest / library_subpath(ev["id"])
            if not (folder / "clip.mp4").exists() or not (folder / "checksums.sha256").exists():
                return "hold", f"backup of {ev['id']} not found on the external drive"
        elif st.get("delete_recordings_after_backup"):
            return "hold", "no external archive configured; recordings are kept"
    if clipped == 0:
        return "archive_clipless", "no clips came from this recording"
    if not st.get("delete_recordings_after_backup"):
        return "hold", "delete_recordings_after_backup is off"
    return "delete", f"all {clipped} clip(s) extracted, verified and backed up"


def janitor_pass(cfg: Config, db: DB) -> None:
    st = cfg["storage"]
    rec_root = recordings_archive_root(cfg)
    local_root = cfg.path("recordings")
    sessions = db.conn.execute(
        "SELECT * FROM sessions WHERE status='ended' AND start_wall IS NOT NULL "
        "AND (disposition IS NULL OR disposition='offloaded') ORDER BY start_wall").fetchall()
    for sess in sessions:
        if STOP.is_set():
            return
        path = Path(sess["path"])
        if not path.exists():
            continue
        action, reason = session_state(cfg, db, sess)
        if action == "delete":
            _unlink(path)
            sidecar = path.with_name(path.name + ".sha256")
            if sidecar.exists():
                _unlink(sidecar)
            db.set_disposition(sess["id"], "deleted", None)
            db.log_storage("delete_recording", sess["id"], str(path), None, reason)
            log.info("deleted recording %s (%s)", path.name, reason)
        elif action == "archive_clipless":
            if sess["disposition"] == "offloaded":
                db.set_disposition(sess["id"], "archived", str(path))
                continue
            ok, why = drive_ready(rec_root, path.stat().st_size)
            if not ok:
                log.debug("clipless recording %s waiting: %s", path.name, why)
                continue
            dst = rec_root / sess["channel"] / path.name
            h = move_file_verified(path, dst)
            db.set_disposition(sess["id"], "archived", str(dst))
            db.log_storage("archive_recording", sess["id"], str(path), str(dst), h)
            log.info("moved clip-less recording %s -> %s (verified)", path.name, dst)
        elif action == "hold":
            log.debug("holding %s: %s", path.name, reason)

    # Low internal disk: move ended recordings that still have pending work to the external drive.
    try:
        free_gb = shutil.disk_usage(local_root if local_root.exists() else cfg.root).free / 1e9
    except OSError:
        return
    if free_gb >= st["offload_below_gb"]:
        return
    for sess in db.conn.execute(
            "SELECT * FROM sessions WHERE status='ended' AND start_wall IS NOT NULL "
            "AND disposition IS NULL ORDER BY start_wall").fetchall():
        path = Path(sess["path"])
        if not path.exists():
            continue
        try:
            path.relative_to(local_root)
        except ValueError:
            continue  # already off the internal drive
        ok, why = drive_ready(rec_root, path.stat().st_size)
        if not ok:
            log.warning("internal drive low (%.1f GB) but cannot offload %s: %s", free_gb, path.name, why)
            return
        dst = rec_root / sess["channel"] / path.name
        try:
            h = move_file_verified(path, dst)
        except PermissionError:
            log.info("%s is in use (extraction?); will offload it on the next pass", path.name)
            continue
        db.set_disposition(sess["id"], "offloaded", str(dst))
        db.log_storage("offload_recording", sess["id"], str(path), str(dst), h)
        log.info("internal drive low (%.1f GB free): moved %s -> %s (verified); clips will be "
                 "extracted from there", free_gb, path.name, dst)
        free_gb = shutil.disk_usage(local_root).free / 1e9
        if free_gb >= st["offload_below_gb"]:
            return


def storage_forever(cfg: Config, db: DB) -> None:
    """Archive worker + janitor in one process."""
    from .worker import process_one
    q = cfg["queue"]
    last_janitor = 0.0
    log.info("storage worker ready (raw -> %s, edited -> %s, recordings archive -> %s)",
             raw_archive_root(cfg), edited_root(cfg), recordings_archive_root(cfg))
    while not STOP.is_set():
        worked = process_one(cfg, db, "archive", handle_archive, lease_seconds=3600)
        if time.time() - last_janitor > cfg["storage"]["janitor_seconds"]:
            try:
                janitor_pass(cfg, db)
            except Exception as e:  # noqa: BLE001 - never let cleanup crash the worker
                log.exception("janitor pass failed: %s", e)
            last_janitor = time.time()
        if not worked:
            STOP.wait(q["poll_seconds"])


def status_lines(cfg: Config, db: DB) -> list[str]:
    out = []
    for sess in db.conn.execute("SELECT * FROM sessions WHERE status='ended' AND start_wall IS NOT NULL "
                                "ORDER BY start_wall DESC LIMIT 10").fetchall():
        if sess["disposition"] in ("deleted", "archived"):
            out.append(f"  {sess['id']:<40} {sess['disposition']}")
            continue
        action, reason = session_state(cfg, db, sess)
        out.append(f"  {sess['id']:<40} {action:<16} {reason}")
    return out


def summary(cfg: Config) -> dict:
    return {"raw_clips_dir": str(raw_archive_root(cfg)), "edited_dir": str(edited_root(cfg)),
            "recordings_archive_dir": str(recordings_archive_root(cfg)), "checked_utc": utc_iso(time.time())}


__all__ = ["handle_archive", "janitor_pass", "storage_forever", "copy_tree_verified", "verify_tree",
           "move_file_verified", "session_state", "library_subpath", "json"]
