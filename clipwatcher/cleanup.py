"""Storage manager: see what takes space, and delete old material safely.

Nothing here deletes on its own. `scan` lists everything with its size, age and state, `plan`
applies "older than N days" to it and says exactly what would go and what is refused, and `run`
deletes only the items you pass, after checking each one again at that moment.

What is refused (blocked), and who can override it:
  recording   still being written, clips not yet cut or backed up         never overridable
  raw clip    local copy without a verified backup                        never overridable
  raw backup  a Short made from it is not uploaded or discarded yet       overridable per item
  Short       not uploaded or discarded yet (clips.json "upload" state)   overridable per item
  library     as for a Short; a stream folder only goes when ALL its Shorts are done

Every deletion goes through `storage` (its read-only-file handling) and is written to
`storage_log` as `manual_delete`. Nothing under data/recordings or data/raw_clips is touched by
anything but this module and `storage`.
"""
from __future__ import annotations

import hashlib
import json
import logging
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

from . import storage
from .config import Config
from .db import DB

log = logging.getLogger("cleanup")

DONE_STATES = ("uploaded", "published", "discarded")
KINDS = ("recording", "raw_backup", "raw_clip", "short", "library")


@dataclass
class Item:
    id: str
    kind: str
    label: str
    path: str
    size: int
    age_days: float
    safe: bool = True
    reason: str = ""            # why it is blocked (empty when safe)
    overridable: bool = False   # may the user force it?
    state: str = ""             # human state: "uploaded", "backed up", "waiting", ...
    event_id: str = ""
    extra: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)


# ------------------------------------------------------------------ helpers
def _size(p: Path) -> int:
    try:
        if p.is_file():
            return p.stat().st_size
        return sum(f.stat().st_size for f in p.rglob("*") if f.is_file())
    except OSError:
        return 0


def _age_days(p: Path, now: float) -> float:
    try:
        return max(0.0, (now - p.stat().st_mtime) / 86400)
    except OSError:
        return 0.0


def _id(kind: str, path: Path) -> str:
    return hashlib.sha1(f"{kind}|{path}".encode("utf-8")).hexdigest()[:16]


def _clips_doc(folder: Path) -> dict | None:
    try:
        d = json.loads((folder / "clips.json").read_text(encoding="utf-8"))
        return d if isinstance(d, dict) and isinstance(d.get("clips"), list) else None
    except (OSError, ValueError):
        return None


def upload_state(cfg: Config, event_id: str) -> str:
    """'uploaded' | 'published' | 'discarded' | 'queued' | ... | 'none' for one Short, from the library."""
    from .library import library_root
    root = library_root(cfg)
    if not root.exists():
        return "none"
    for folder in root.glob("*/*"):
        doc = _clips_doc(folder)
        for c in (doc or {}).get("clips", []):
            if c.get("event_id") == event_id:
                return (c.get("upload") or {}).get("status") or "none"
    return "none"


def _short_done(cfg: Config, event_id: str) -> tuple[bool, str]:
    st = upload_state(cfg, event_id)
    if st in DONE_STATES:
        return True, st
    return False, ("not uploaded yet" if st in ("none", "queued") else f"upload is {st.replace('_', ' ')}")


# --------------------------------------------------------------------- scan
def scan(cfg: Config, db: DB, now: float | None = None) -> list[Item]:
    now = now or time.time()
    items: list[Item] = []
    active_edit = {r["event_id"] for r in db.conn.execute(
        "SELECT event_id FROM jobs WHERE stage IN ('extract','transcribe','edit') AND status IN ('pending','running')")}

    # --- recordings (local + archive) -------------------------------------------------------
    for sess in db.conn.execute("SELECT * FROM sessions ORDER BY created").fetchall():
        p = Path(sess["path"])
        if not p.exists():
            continue
        it = Item(_id("recording", p), "recording", f"{sess['channel']} {sess['kind']} {sess['id']}", str(p),
                  _size(p), _age_days(p, now), state=sess["status"], extra={"session": sess["id"]})
        if sess["status"] == "recording":
            it.safe, it.reason = False, "still recording"
        else:
            action, why = storage.session_state(cfg, db, sess)
            if action == "delete" or (action == "hold" and "delete_recordings_after_backup is off" in why):
                it.state = "all clips backed up"
            elif action == "archive_clipless":
                it.state = "no clips came from it"
                it.safe, it.reason, it.overridable = False, "no clips were made from it: this is the only copy", True
            else:
                it.safe, it.reason = False, why
        items.append(it)

    # --- raw clips: local staging and the external backup -----------------------------------
    local_root = cfg.path("raw_clips")
    arch_root = storage.raw_archive_root(cfg)
    seen: set[str] = set()
    for root, kind in ((local_root, "raw_clip"), (arch_root, "raw_backup")):
        if root is None or not root.exists():
            continue
        for d in sorted(root.glob("*/*/*")) if kind == "raw_backup" else sorted(root.glob("*")):
            if not d.is_dir() or not (d / "clip.mp4").exists():
                continue
            ev = d.name
            it = Item(_id(kind, d), kind, ev, str(d), _size(d), _age_days(d, now), event_id=ev)
            if ev in active_edit:
                it.safe, it.reason = False, "still being processed"
            elif kind == "raw_clip":
                dest = arch_root / storage.library_subpath(ev) if arch_root else None
                if dest is None or storage.verify_tree(dest) or not (dest / "clip.mp4").exists():
                    it.safe, it.reason = False, "no verified backup of this clip yet"
                else:
                    it.state = "backed up"
            else:
                ok, why = _short_done(cfg, ev)
                has_short = (storage.edited_root(cfg) / storage.library_subpath(ev) / "short.mp4").exists()
                if has_short and not ok:
                    it.safe, it.reason, it.overridable = False, f"its Short is {why}", True
                elif not has_short:
                    edit = db.job(ev, "edit")
                    it.state = f"no Short ({edit['status'] if edit else 'not edited'})"
                    if edit is None or edit["status"] in ("failed", "pending", "running", "manual"):
                        it.safe, it.reason, it.overridable = False, "the only copy of a clip that was never edited", True
                else:
                    it.state = f"Short {why}"
            seen.add(ev)
            items.append(it)

    # --- edited Shorts -------------------------------------------------------------------------
    er = storage.edited_root(cfg)
    for d in sorted(er.glob("*/*/*")) if er.exists() else []:
        if not (d / "short.mp4").exists():
            continue
        ev = d.name
        ok, why = _short_done(cfg, ev)
        it = Item(_id("short", d), "short", ev, str(d), _size(d), _age_days(d, now), event_id=ev, state=why)
        if ev in active_edit:
            it.safe, it.reason = False, "still being processed"
        elif not ok:
            it.safe, it.reason, it.overridable = False, f"{why}: deleting it loses the finished Short", True
        items.append(it)

    # --- library stream folders (one item per folder; all its Shorts must be done) --------------
    from .library import library_root
    lr = library_root(cfg)
    for d in sorted(lr.glob("*/*")) if lr.exists() else []:
        doc = _clips_doc(d)
        if doc is None:
            continue
        pending = [c["file"] for c in doc["clips"] if (c.get("upload") or {}).get("status") not in DONE_STATES]
        it = Item(_id("library", d), "library", f"{d.parent.name} / {d.name}", str(d), _size(d), _age_days(d, now),
                  state=f"{len(doc['clips']) - len(pending)}/{len(doc['clips'])} uploaded or discarded")
        if pending:
            it.safe, it.reason, it.overridable = False, f"{len(pending)} Short(s) not uploaded or discarded yet", True
        items.append(it)
    return items


# --------------------------------------------------------------- plan / run
def plan(cfg: Config, db: DB, older_than_days: float = 30, kinds: list[str] | None = None,
         now: float | None = None) -> dict:
    """What a cleanup with these rules would delete, what it refuses, and the space it frees."""
    kinds = [k for k in (kinds or KINDS) if k in KINDS]
    items = scan(cfg, db, now)
    cand = [i for i in items if i.kind in kinds and i.age_days >= older_than_days]
    ok = [i for i in cand if i.safe]
    blocked = [i for i in cand if not i.safe]
    return {"older_than_days": older_than_days, "kinds": kinds,
            "delete": [i.to_dict() for i in ok], "blocked": [i.to_dict() for i in blocked],
            "free_bytes": sum(i.size for i in ok),
            "total_bytes": sum(i.size for i in items),
            "by_kind": {k: sum(i.size for i in items if i.kind == k) for k in KINDS}}


def run(cfg: Config, db: DB, item_ids: list[str], override_ids: list[str] | None = None,
        now: float | None = None) -> dict:
    """Delete the chosen items. Each is re-checked now; a refused item is reported, never forced
    unless it is overridable AND the caller named it in override_ids."""
    override = set(override_ids or [])
    by_id = {i.id: i for i in scan(cfg, db, now)}
    deleted, refused, freed = [], [], 0
    for iid in item_ids:
        it = by_id.get(iid)
        if it is None:
            refused.append({"id": iid, "reason": "no longer exists"})
            continue
        if not it.safe and not (it.overridable and iid in override):
            refused.append({"id": iid, "label": it.label, "reason": it.reason or "not safe to delete"})
            continue
        p = Path(it.path)
        try:
            if p.is_dir():
                storage._rmtree(p)
            elif p.exists():
                storage._unlink(p)
            if it.kind == "recording" and it.extra.get("session"):
                db.set_disposition(it.extra["session"], "deleted", None)
            db.log_storage("manual_delete", it.event_id or it.label, str(p), None,
                           f"{it.kind}{' (override)' if not it.safe else ''}: {it.state}")
            deleted.append({"id": iid, "label": it.label, "bytes": it.size})
            freed += it.size
            log.info("deleted %s %s (%d bytes)", it.kind, it.label, it.size)
        except OSError as e:
            refused.append({"id": iid, "label": it.label, "reason": f"could not delete: {str(e)[:160]}"})
    return {"deleted": deleted, "refused": refused, "freed_bytes": freed}


def summary(cfg: Config, db: DB) -> dict:
    items = scan(cfg, db)
    import shutil
    disks = {}
    for name, p in (("project", cfg.root), ("backup", storage.raw_archive_root(cfg))):
        try:
            if p is not None:
                u = shutil.disk_usage(p if p.exists() else p.anchor)
                disks[name] = {"path": str(p), "free_bytes": u.free, "total_bytes": u.total}
        except OSError:
            pass
    return {"items": [i.to_dict() for i in items],
            "by_kind": {k: sum(i.size for i in items if i.kind == k) for k in KINDS},
            "total_bytes": sum(i.size for i in items), "disks": disks}
