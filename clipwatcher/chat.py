"""STEP 2 - Read Twitch chat over IRC (read-only) and write chat.log.

Connects to irc.chat.twitch.tv (TLS 6697 by default, plain 6667 optional),
logs in anonymously as justinfanNNNN, and joins #CHANNEL. If Twitch refuses the
anonymous login and the user configured their own account (username + OAuth
token with the chat:read scope), it logs in with that instead.

This client never sends chat messages: the only commands it can put on the
wire are CAP, PASS, NICK, JOIN, PING and PONG (enforced in `_send`).

chat.log is JSON Lines, one object per line, in arrival order:
  {"type": "msg", "t": <local epoch>, "tmi_ts": <twitch epoch>, "user": ..., "name": ..., "text": ..., "id": ...}
  {"type": "connect", "t": ...}      joined the channel, monitoring is live
  {"type": "heartbeat", "t": ...}    still connected (every few seconds)
  {"type": "disconnect", "t": ..., "reason": ...}
`t` is the local receive time - the same clock the recorder uses - so chat and
video line up without depending on Twitch's server clock.
"""
from __future__ import annotations

import json
import logging
import random
import socket
import ssl
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import TextIO

from .config import Config
from .util import STOP

log = logging.getLogger("chat")

ALLOWED_COMMANDS = {"CAP", "PASS", "NICK", "JOIN", "PING", "PONG"}
AUTH_FAILURE_HINTS = ("login authentication failed", "improperly formatted auth",
                      "invalid nick", "login unsuccessful")


# ------------------------------------------------------------------ parsing
@dataclass
class IrcMessage:
    tags: dict[str, str] = field(default_factory=dict)
    prefix: str = ""
    command: str = ""
    params: list[str] = field(default_factory=list)

    @property
    def nick(self) -> str:
        return self.prefix.split("!", 1)[0] if self.prefix else ""

    @property
    def trailing(self) -> str:
        return self.params[-1] if self.params else ""


_TAG_UNESCAPE = {"\\:": ";", "\\s": " ", "\\\\": "\\", "\\r": "\r", "\\n": "\n"}


def _unescape_tag(v: str) -> str:
    out, i = [], 0
    while i < len(v):
        pair = v[i:i + 2]
        if pair in _TAG_UNESCAPE:
            out.append(_TAG_UNESCAPE[pair])
            i += 2
        else:
            out.append(v[i])
            i += 1
    return "".join(out)


def parse_irc(line: str) -> IrcMessage:
    msg = IrcMessage()
    rest = line.rstrip("\r\n")
    if rest.startswith("@"):
        raw_tags, _, rest = rest[1:].partition(" ")
        for item in raw_tags.split(";"):
            k, _, v = item.partition("=")
            msg.tags[k] = _unescape_tag(v)
    if rest.startswith(":"):
        msg.prefix, _, rest = rest[1:].partition(" ")
    if " :" in rest:
        head, _, trailing = rest.partition(" :")
        parts = head.split()
        parts.append(trailing)
    else:
        parts = rest.split()
    if parts:
        msg.command = parts[0].upper()
        msg.params = parts[1:]
    return msg


def chat_record(msg: IrcMessage, t: float) -> dict:
    """Turn a PRIVMSG into a chat.log record."""
    tmi = msg.tags.get("tmi-sent-ts")
    return {
        "type": "msg",
        "t": round(t, 3),
        "tmi_ts": round(int(tmi) / 1000, 3) if tmi and tmi.isdigit() else None,
        "user": msg.nick,
        "name": msg.tags.get("display-name") or msg.nick,
        "text": msg.trailing,
        "id": msg.tags.get("id"),
    }


# ------------------------------------------------------------------ client
class AuthFailed(Exception):
    pass


class ChatReader:
    def __init__(self, cfg: Config, log_path: Path):
        self.cfg = cfg
        self.c = cfg["chat"]
        self.channel = cfg.channel
        self.log_path = log_path
        self.sock: socket.socket | None = None
        self.out: TextIO | None = None
        self.use_auth = False

    # -- output
    def _write(self, record: dict) -> None:
        assert self.out is not None
        self.out.write(json.dumps(record, ensure_ascii=False) + "\n")
        self.out.flush()

    # -- wire
    def _send(self, line: str) -> None:
        command = line.split(" ", 1)[0].upper()
        if command not in ALLOWED_COMMANDS:  # read-only guarantee
            raise PermissionError(f"refusing to send IRC command {command!r}")
        assert self.sock is not None
        self.sock.sendall((line + "\r\n").encode("utf-8"))

    def _connect(self) -> None:
        host, port = self.c["server"], int(self.c["port"])
        raw = socket.create_connection((host, port), timeout=15)
        if self.c.get("tls", True):
            ctx = ssl.create_default_context()
            self.sock = ctx.wrap_socket(raw, server_hostname=host)
        else:
            self.sock = raw
        self.sock.settimeout(1.0)
        self._send("CAP REQ :twitch.tv/tags twitch.tv/commands")
        if self.use_auth:
            token = self.cfg.oauth_token
            token = token if token.startswith("oauth:") else f"oauth:{token}"
            self._send(f"PASS {token}")
            self._send(f"NICK {self.c['username'].lower()}")
            log.info("logging in as %s (authenticated, read-only)", self.c["username"])
        else:
            nick = f"justinfan{random.randint(10000, 99999)}"
            self._send(f"NICK {nick}")
            log.info("logging in anonymously as %s", nick)

    def _lines(self):
        """Yield decoded lines; yields None every ~1s so the caller can do timers."""
        assert self.sock is not None
        buf = b""
        while not STOP.is_set():
            try:
                chunk = self.sock.recv(65536)
            except (socket.timeout, TimeoutError):
                yield None
                continue
            if not chunk:
                raise ConnectionError("server closed the connection")
            buf += chunk
            while b"\r\n" in buf:
                line, buf = buf.split(b"\r\n", 1)
                yield line.decode("utf-8", errors="replace")

    def _session(self) -> None:
        """One connection: login, join, read until it drops."""
        self._connect()
        joined = False
        welcome_deadline = time.time() + 20
        last_rx = time.time()
        last_ping = time.time()
        last_hb = 0.0
        hb = float(self.c["heartbeat_seconds"])
        for line in self._lines():
            now = time.time()
            if line is None:
                if not joined and now > welcome_deadline:
                    raise AuthFailed("no welcome from server (login not accepted)")
            else:
                last_rx = now
                msg = parse_irc(line)
                cmd = msg.command
                if cmd == "PING":
                    self._send(f"PONG :{msg.trailing}")
                elif cmd == "001":
                    self._send(f"JOIN #{self.channel}")
                elif cmd in ("ROOMSTATE", "JOIN") and not joined:
                    if cmd == "ROOMSTATE" or msg.params[:1] == [f"#{self.channel}"]:
                        joined = True
                        self._write({"type": "connect", "t": round(now, 3), "channel": self.channel,
                                     "auth": self.use_auth})
                        log.info("joined #%s - monitoring chat", self.channel)
                elif cmd == "PRIVMSG" and joined:
                    self._write(chat_record(msg, now))
                elif cmd == "NOTICE":
                    text = msg.trailing.lower()
                    log.warning("NOTICE: %s", msg.trailing)
                    if any(h in text for h in AUTH_FAILURE_HINTS):
                        raise AuthFailed(msg.trailing)
                elif cmd == "RECONNECT":
                    raise ConnectionError("server requested RECONNECT")
            if joined and now - last_hb >= hb:
                self._write({"type": "heartbeat", "t": round(now, 3)})
                last_hb = now
            if now - last_ping >= 60:
                self._send("PING :tmi.twitch.tv")
                last_ping = now
            if now - last_rx > 180:
                raise ConnectionError("no data from server for 180s")

    def run_forever(self) -> None:
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        backoff = 1.0
        with open(self.log_path, "a", encoding="utf-8") as self.out:
            while not STOP.is_set():
                started = time.time()
                reason = "stopped"
                try:
                    self._session()
                except AuthFailed as e:
                    reason = f"auth failed: {e}"
                    if not self.use_auth and self.c.get("username") and self.cfg.oauth_token:
                        log.warning("anonymous access refused (%s); switching to your own account", e)
                        self.use_auth = True
                        backoff = 1.0
                    elif not self.use_auth:
                        log.error("anonymous access refused (%s). Set chat.username and "
                                  "chat.oauth_token (or TWITCH_OAUTH_TOKEN) to use your own "
                                  "account with chat:read scope.", e)
                    else:
                        log.error("authenticated login refused: %s", e)
                except (OSError, ConnectionError) as e:
                    reason = str(e)
                    log.warning("chat connection lost: %s", e)
                finally:
                    if self.sock is not None:
                        try:
                            self.sock.close()
                        except OSError:
                            pass
                        self.sock = None
                    self._write({"type": "disconnect", "t": round(time.time(), 3), "reason": reason})
                if STOP.is_set():
                    break
                if time.time() - started > 60:
                    backoff = 1.0  # the last connection was healthy
                log.info("reconnecting in %.0fs", backoff)
                STOP.wait(backoff)
                backoff = min(backoff * 2, float(self.c["reconnect_max_backoff"]))


def chat_log_path(cfg: Config, channel: str | None = None, session_id: str | None = None) -> Path:
    """The live chat log of a channel, or (for a VOD session) the log built from its chat replay."""
    base = cfg.path("chat") / (channel or cfg.channel)
    if session_id:
        per_session = base / f"{session_id}.log"
        if per_session.exists():
            return per_session
    return base / "chat.log"


def read_records(path: Path, start_offset: int = 0):
    """Yield (offset_of_line, next_offset, record) from chat.log, skipping torn lines."""
    with open(path, "rb") as fh:
        fh.seek(start_offset)
        offset = start_offset
        for raw in fh:
            nxt = offset + len(raw)
            if raw.endswith(b"\n"):
                try:
                    yield offset, nxt, json.loads(raw)
                except json.JSONDecodeError:
                    pass
            else:
                return  # partial last line still being written
            offset = nxt


def _seek_time(fh, target: float, size: int) -> int:
    """Binary search chat.log (time-ordered) for the first line with t >= target."""
    lo, hi = 0, size
    while hi - lo > 4096:
        mid = (lo + hi) // 2
        fh.seek(mid)
        fh.readline()  # skip to the next full line
        pos = fh.tell()
        line = fh.readline()
        try:
            t = json.loads(line)["t"]
        except (ValueError, KeyError, TypeError):
            t = None
        if t is None or t >= target:
            hi = mid
        else:
            lo = pos
    return lo


def read_window(path: Path, t0: float, t1: float) -> list[dict]:
    """All chat messages with t0 <= t < t1, found by binary search (chat.log can be huge)."""
    if not path.exists():
        return []
    out = []
    size = path.stat().st_size
    with open(path, "rb") as fh:
        start = _seek_time(fh, t0, size)
    for _, _, rec in read_records(path, start):
        t = rec.get("t", 0)
        if t >= t1:
            break
        if rec.get("type") == "msg" and t >= t0:
            out.append(rec)
    return out
