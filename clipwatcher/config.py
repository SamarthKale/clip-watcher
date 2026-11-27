"""Configuration loading.

Settings come from three layers (later wins):
  1. DEFAULTS below
  2. a TOML file (config.toml by default, optional)
  3. command-line overrides (e.g. --channel)

The channel is never hardcoded: it must come from the CLI or the config file.
"""
from __future__ import annotations

import copy
import os
import re
import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Any

DEFAULTS: dict[str, Any] = {
    "channel": "",
    # Optional pretty name used in credits; falls back to the channel login.
    "streamer_display_name": "",
    "paths": {
        "data_dir": "data",  # everything below is relative to data_dir
        "recordings": "recordings",
        "chat": "chat",
        "raw_clips": "raw_clips",
        "jobs": "jobs",
        "shorts": "shorts",
        "db": "clipwatcher.db",
        "logs": "logs",
    },
    "record": {
        "streamlink": "streamlink",
        "quality": "best",
        "retry_streams": 30,  # seconds between "is the channel live?" polls
        "retry_open": 3,
        "extra_args": [],  # e.g. ["--twitch-api-header", "Authorization=OAuth xxx"]
        "restart_backoff": 5,
        # Below this much free space the current recording file is closed and a new one
        # started, so the storage stage can move the finished file to the external drive.
        "rollover_below_gb": 8,
        # Below this, recording pauses entirely (nothing could be offloaded in time).
        "min_free_gb": 3,
    },
    "storage": {
        # Raw Cut Clips -> external drive. Empty = keep raw clips locally (no backup, no deletions).
        "raw_clips_dir": "",
        # Edited Clips -> internal drive (relative paths are under the project folder).
        "edited_dir": "Edited Clips",
        # Recordings with no clips (and offloaded recordings) go here. Empty = keep them locally.
        "recordings_archive_dir": "",
        # Delete a recording once every clip from it is extracted, verified and backed up.
        "delete_recordings_after_backup": True,
        "settle_minutes": 15,  # wait this long after a stream ends before deciding
        "offload_below_gb": 12,  # move ended recordings off the internal drive below this
        "janitor_seconds": 60,
        "retry_minutes": 10,  # how often to retry when the external drive is missing
    },
    "chat": {
        "server": "irc.chat.twitch.tv",
        "port": 6697,
        "tls": True,
        # Anonymous read-only login is tried first. If Twitch rejects it and
        # both of these are set, the user's own account is used instead.
        "username": "",
        "oauth_token": "",  # or env var TWITCH_OAUTH_TOKEN; "oauth:" prefix optional
        "heartbeat_seconds": 5,
        "reconnect_max_backoff": 60,
    },
    "detect": {
        "bucket_seconds": 10,
        "window_seconds": 300,  # rolling baseline: previous 5 minutes
        "threshold": 3.0,  # spike when bucket >= threshold x baseline
        "min_history_seconds": 300,  # ignore detections until this much history exists
        "min_baseline": 1.0,  # floor for the baseline (msgs/bucket); guards zero/low chat
        "min_spike_messages": 8,  # a bucket also needs at least this many messages
        "cooldown_seconds": 90,  # no new event this soon after the previous one ended
        "max_run_buckets": 6,  # force-emit an event after this many consecutive spike buckets
        "gap_seconds": 20,  # silence in chat.log longer than this = monitoring gap
        # A spike from a different detector (audio) this close to an existing event is the
        # same moment and is recorded on it instead of cutting a second clip.
        "merge_window_seconds": 45,
        # Optional second trigger: loudness spikes in the recording (screams, explosions).
        # Off by default - the chat detector above stays the default trigger.
        "audio": {
            "enabled": False,
            "rise_lu": 12.0,  # spike when a second is this many LU above the baseline (12 ~ a scream)
            "floor_lufs": -24.0,  # ...and at least this loud
            "window_seconds": 300,  # rolling baseline: mean of the previous 5 minutes
            "min_history_seconds": 120,
            "min_seconds": 2,  # sustained at least this long (filters single gunshots)
            "max_run_seconds": 10,
            "cooldown_seconds": 90,
            "gap_seconds": 5,
            "chunk_seconds": 30,  # how much new recording to scan at a time
            "safety_seconds": 10,  # stay this far behind the live edge of the file
        },
    },
    "sync": {
        # Added to a chat timestamp to place it on the recording timeline.
        # Positive = the moment in the video happened later than chat says.
        "chat_offset_seconds": 0.0,
    },
    "extract": {
        "ffmpeg": "ffmpeg",
        "ffprobe": "ffprobe",
        "pre_seconds": 75,
        "post_seconds": 75,
        "safety_seconds": 10,  # extra footage to wait for past the window end
        "frames_every_seconds": 10,
        "frame_width": 640,
        "chat_context_seconds": 60,  # chat saved on each side of the spike
        # signals.json: loudness peaks, silences, scene changes, chat emote categories and a
        # triage score - helps the editor find the exact moment and its type.
        "signals": True,
        "scene_detect": True,
    },
    "transcribe": {
        "enabled": True,
        "whisper_cli": "whisper-cli",
        # Multilingual model: Hindi, English and Hinglish are detected per clip ("auto"). Captions are
        # always written in Latin letters. Use ggml-base.en.bin with language "en" for English only.
        "model": "models/ggml-large-v3-turbo-q5_0.bin",
        "language": "auto",
        "threads": 4,
        "extra_args": [],
    },
    "edit": {
        # "claude": run Claude Code headless on each job automatically.
        # "manual": leave jobs queued; run `claude` and use /edit-short yourself.
        "mode": "claude",
        "claude": "claude",
        "max_turns": 80,
        "timeout_seconds": 3600,
        "allowed_tools": [
            "Read", "Write", "Edit", "Glob", "Grep",
            "Bash(ffmpeg *)", "Bash(ffprobe *)", "Bash(python *)", "Bash(py *)",
            # Windows: Claude often calls the .exe names, which "python *" does not match
            "Bash(python.exe *)", "Bash(py.exe *)", "Bash(mkdir *)",
            # Claude calls the bundled binaries by relative path (tools/ffmpeg/ffmpeg.exe, ../../tools/...)
            "Bash(*ffmpeg.exe *)", "Bash(*ffprobe.exe *)",
        ],
        "extra_args": [],
        "max_short_seconds": 60,
        # Aim for about this length when the footage supports it (0 = no preference). The hard
        # limit stays max_short_seconds.
        "target_short_seconds": 0,
        # finish rejects a Short shorter than this (0 = no minimum)
        "min_short_seconds": 0,
        # true: never reject a clip for a low score or "no real moment" - always render the best
        # Short the footage allows (edits run highest triage score first). Safety and copyright
        # rejections still apply.
        "render_all": False,
        # finish requires the SEO block (title, description, hashtags, tags, captions) in
        # edit_decisions.json; the library step then publishes the Short for the uploader.
        "require_seo": True,
        # Stop retrying a clip once its Claude usage (list-price equivalent) reaches this (0 = no cap).
        "max_spend_usd": 6.0,
        "library": True,
    },
    "vod": {
        "ytdlp": "yt-dlp",
        "max_height": 1080,            # download at most this resolution
        "download_timeout": 7200,      # seconds
        "min_chat_messages": 200,      # a chat replay with fewer messages is ignored (audio is used)
        "audio_always": False,         # also run the loudness detector when a chat replay was used
        "watch_interval_minutes": 60,  # how often the watch list is checked while the pipeline runs
    },
    "scout": {
        # Videos with no usable chat (ordinary uploads, podcasts, most VODs): transcribe the whole
        # video with a fast multilingual model, then Claude Code picks the best moments from it.
        "enabled": True,
        "model": "models/ggml-base.bin",
        "language": "auto",
        "threads": 4,
        "timeout_seconds": 900,     # one Claude call
        "max_chars": 120000,        # transcript characters per Claude call; longer videos are read in parts
        "min_seconds": 15,
        "max_seconds": 90,
    },
    "library": {
        # Where finished Shorts are published for the uploader (relative = under the project folder).
        "dir": "Shorts",
    },
    "export": {
        # Platform files written by `finish` into <Short>/final/. The master short.mp4 is
        # reused whenever it already meets a platform's spec (no duplicate, no re-encode).
        "enabled": True,
        "platforms": ["youtube_shorts", "tiktok", "instagram_reels"],
        "thumbnail": True,  # thumbnail.jpg (1280x720) + cover.jpg (1080x1920)
    },
    "queue": {
        "max_attempts": 4,
        "lease_seconds": 900,  # a crashed worker's job is reclaimed after this
        "poll_seconds": 3,
    },
}

_CHANNEL_RE = re.compile(r"^[a-z0-9_]{2,25}$")


def normalize_channel(value: str) -> str:
    """Accept 'name', '#name', 'twitch.tv/name' or a full URL; return the login."""
    v = (value or "").strip().lower()
    v = re.sub(r"^https?://", "", v)
    v = re.sub(r"^(www\.|m\.)?twitch\.tv/", "", v)
    v = v.lstrip("#").strip("/").split("/")[0].split("?")[0]
    if not _CHANNEL_RE.match(v):
        raise ValueError(f"not a valid Twitch channel name: {value!r}")
    return v


def _merge(base: dict, override: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in override.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _merge(out[k], v)
        else:
            out[k] = v
    return out


@dataclass
class Config:
    raw: dict[str, Any]
    root: Path  # directory paths are resolved against
    source: Path | None = None  # the TOML file that was loaded, if any
    source: Path | None = None  # the TOML file that was loaded, if any

    def __getitem__(self, key: str) -> Any:
        return self.raw[key]

    @property
    def channel(self) -> str:
        return self.raw["channel"]

    @property
    def display_name(self) -> str:
        return self.raw.get("streamer_display_name") or self.channel

    @property
    def data_dir(self) -> Path:
        p = Path(self.raw["paths"]["data_dir"])
        return p if p.is_absolute() else self.root / p

    def path(self, name: str) -> Path:
        p = Path(self.raw["paths"][name])
        return p if p.is_absolute() else self.data_dir / p

    def resolve(self, value: str) -> Path:
        """Resolve a user-supplied relative path (e.g. a model file) against root.

        The installed app ships some files (the speech model) in its own resources folder
        (CLIPPER_RESOURCES); a relative path missing from root falls back to that copy."""
        p = Path(value)
        if p.is_absolute():
            return p
        local = self.root / p
        res = os.environ.get("CLIPPER_RESOURCES")
        if not local.exists() and res and (Path(res) / p).exists():
            return Path(res) / p
        return local

    @property
    def oauth_token(self) -> str:
        return self.raw["chat"].get("oauth_token") or os.environ.get("TWITCH_OAUTH_TOKEN", "")


def load_config(path: str | os.PathLike | None = None, overrides: dict | None = None,
                require_channel: bool = False) -> Config:
    raw = copy.deepcopy(DEFAULTS)
    root = Path.cwd()
    source = None
    if path is not None:
        p = Path(path)
        if p.exists():
            with open(p, "rb") as fh:
                raw = _merge(raw, tomllib.load(fh))
            root = p.resolve().parent
            source = p.resolve()
        elif str(path) != "config.toml":  # the default file is optional
            raise FileNotFoundError(f"config file not found: {p}")
    if overrides:
        raw = _merge(raw, {k: v for k, v in overrides.items() if v not in (None, "")})
    if raw.get("channel"):
        raw["channel"] = normalize_channel(raw["channel"])
    elif require_channel:
        raise SystemExit("A Twitch channel is required: pass --channel NAME or set channel in config.toml")
    return Config(raw=raw, root=root, source=source)
