from __future__ import annotations

import json
import logging
import os
import shutil
import signal
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

STOP = threading.Event()


def install_stop_handlers() -> None:
    def _handler(signum, frame):  # noqa: ARG001
        STOP.set()
    signal.signal(signal.SIGINT, _handler)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, _handler)
    if hasattr(signal, "SIGBREAK"):  # Windows Ctrl+Break / console close
        signal.signal(signal.SIGBREAK, _handler)


def setup_logging(name: str, log_dir: Path | None = None, verbose: bool = False) -> logging.Logger:
    fmt = logging.Formatter("%(asctime)s %(levelname)-7s [%(name)s] %(message)s")
    root = logging.getLogger()
    root.setLevel(logging.DEBUG if verbose else logging.INFO)
    if not root.handlers:
        h = logging.StreamHandler(sys.stdout)
        h.setFormatter(fmt)
        root.addHandler(h)
        if log_dir is not None:
            log_dir.mkdir(parents=True, exist_ok=True)
            fh = logging.FileHandler(log_dir / f"{name}.log", encoding="utf-8")
            fh.setFormatter(fmt)
            root.addHandler(fh)
    return logging.getLogger(name)


def utc_iso(epoch: float | None) -> str | None:
    if epoch is None:
        return None
    return datetime.fromtimestamp(epoch, tz=timezone.utc).isoformat(timespec="milliseconds")


def utc_stamp(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, tz=timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def hms(seconds: float) -> str:
    seconds = max(0.0, seconds)
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{int(h):02d}:{int(m):02d}:{s:06.3f}"


def write_json(path: Path, data: Any) -> None:
    """Atomic JSON write (write temp file, then rename)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def which(binary: str) -> str | None:
    if os.path.sep in binary or (os.altsep and os.altsep in binary):
        return binary if Path(binary).exists() else None
    return shutil.which(binary)


def channel_url(channel: str) -> str:
    return f"https://www.twitch.tv/{channel}"
