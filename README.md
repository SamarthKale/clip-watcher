# Clip Watcher

Clip Watcher watches a Twitch channel and finds the moments chat goes wild. It cuts raw footage
around each moment, transcribes it, and hands it to [Claude Code](https://claude.com/claude-code),
which edits it into a vertical YouTube Short.

```
live stream -> recording (streamlink) -> chat log (Twitch IRC) -> 10 s chat buckets
  -> 3x rolling-average spike -> raw footage (60 s before + 60 s after) -> transcript (whisper.cpp)
  -> Claude Code edit -> finished Short (Edited Clips)
  -> verified backup of raw clips (external drive) -> safe cleanup of recordings
```

**Nothing is ever uploaded or published automatically.** Every Short is a file for you to review.

## Features

- **Dynamic channel selection.** Nothing is hardcoded. Pass `--channel` or set it in `config.toml`.
- **Read-only chat capture.** It connects anonymously over TLS and can only send the IRC handshake
  commands (CAP, PASS, NICK, JOIN, PING, PONG). It never posts messages.
- **Transparent spike detection.** The default algorithm is a plain 3x rolling average. It is easy
  to read, tune and test.
- **Keyframe-accurate cuts.** Stream copies start on a keyframe, so audio and video line up. The
  source timestamps are recorded.
- **Crash-tolerant pipeline.** Each stage is its own process with a persistent SQLite queue. Leases,
  retries and backoff mean that a stage crashing or stalling never blocks recording or chat capture.
- **Safe storage.** Raw clips are copied to an external drive and checksum-verified on both sides.
  A recording is deleted only after all of its clips are extracted, verified and backed up.
- **Attribution on every output.** Every clip and Short records the streamer, channel URL, recording
  session, source timestamps and event ID.
- **Original sound library.** The included sound effects and music are synthesized from scratch and
  licensed CC0. The editor can use only assets with a known license.

## Requirements

- **Python 3.11+.** The code uses only the standard library.
- **[streamlink](https://streamlink.github.io/)**, for recording: `pip install streamlink`
- **[FFmpeg](https://ffmpeg.org/)** (`ffmpeg` and `ffprobe`), for cutting and rendering.
  On Windows: `winget install Gyan.FFmpeg`, or a static build from
  [BtbN](https://github.com/BtbN/FFmpeg-Builds/releases).
- **[whisper.cpp](https://github.com/ggml-org/whisper.cpp)** (`whisper-cli`), for transcription, plus a
  model such as `ggml-base.en.bin` or `ggml-medium.en.bin`. Models are at
  [huggingface.co/ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp). Put the model
  at `models/` and set `transcribe.model` to its path.
- **[Claude Code](https://claude.com/claude-code)** (`claude`), for automatic editing. Each edit uses
  your Claude account. Editing is optional: set `edit.mode = "manual"` to edit yourself.

## Quick start

```bash
git clone https://github.com/SamarthKale/clip-watcher.git
cd clip-watcher
cp config.example.toml config.toml        # then edit it: paths, channel, tool locations
python -m clipwatcher make-assets         # generate the sound library in assets/
python -m clipwatcher check               # report missing tools and storage-drive status
python -m clipwatcher run --channel SOME_CHANNEL
```

`run` starts every stage, and each one restarts if it crashes. Stop it with Ctrl+C. To run for a
fixed time, use `--for 600` (seconds).

## Commands

| Command | What it does |
|---|---|
| `run` | Runs all stages, supervised (`--for N` stops gracefully after N seconds) |
| `record`, `chat`, `detect` | Run steps 1–3 on their own |
| `extract`, `transcribe`, `edit`, `storage` | Run the queue workers for steps 4–7 |
| `status` | Sessions, queue counts, recent jobs, errors and storage state |
| `check` | Verify tools, storage drives and the sound library |
| `retry <event_id> <stage>` | Re-queue a failed or skipped job |
| `detect-file <chat.log>` | Run the detector over an existing log (`--enqueue` queues the results) |
| `next-edit` | List editing jobs waiting for a manual Claude session |
| `finish <event_id>` | Validate a Short and write its attribution metadata |
| `make-assets` | Generate or re-index the sound library (`--force` regenerates) |

## Configuration

Copy `config.example.toml` to `config.toml`. Every key is optional, and the defaults are in
`clipwatcher/config.py`. Settings you'll most likely change:

| Section | Key | Purpose |
|---|---|---|
| top level | `channel` | Twitch channel (login or URL). Can also be given with `--channel`. |
| `[record]` | `quality` | e.g. `best`, `1080p60`, `720p60` |
| `[detect]` | `threshold`, `min_spike_messages` | How strong a chat spike must be |
| `[extract]` | `pre_seconds`, `post_seconds` | Length of the window around each spike (default 60 + 60) |
| `[transcribe]` | `whisper_cli`, `model` | Paths to `whisper-cli` and the model |
| `[edit]` | `mode`, `max_short_seconds` | `claude` for automatic edits, `manual` for `/edit-short` |
| `[storage]` | `raw_clips_dir`, `recordings_archive_dir` | External-drive folders. Leave empty to keep everything local. |
| `[sync]` | `chat_offset_seconds` | Shift chat onto the video timeline if you measure a drift |

Tool paths can be set in `config.toml` if they are not on your PATH: `record.streamlink`,
`extract.ffmpeg`, `extract.ffprobe`, `transcribe.whisper_cli`.

Chat works anonymously. An account token is needed only if Twitch refuses anonymous access. Keep
tokens out of version control: set `TWITCH_OAUTH_TOKEN` in the environment instead of the file.

## How it works

Each numbered step is a separate process with its own queue. The queues live in
`data/clipwatcher.db` (SQLite, WAL mode).

1. **Record** (`recorder.py`). Runs `streamlink twitch.tv/CHANNEL best` in a loop. It waits for the
   channel to go live and records continuously. Each disconnect starts a new session file. The local
   time of the first byte is the session's timeline origin. Finished recordings are read-only.
2. **Chat** (`chat.py`). Connects to `irc.chat.twitch.tv:6697` over TLS and joins the channel,
   anonymously as `justinfanNNNNN`. If Twitch refuses anonymous access, it falls back to your own
   account with a `chat:read` token. It reconnects automatically and writes `chat.log` as JSON Lines.
   The log also records connect and disconnect markers and 5-second heartbeats.
3. **Detect** (`detector.py`). Counts messages in 10-second buckets. Each bucket is compared with
   the mean of the **previous** 5 minutes, which never includes the bucket being tested. A bucket at
   3x or above is a spike. Spikes need a minimum message count and must not be near-zero chat. Gaps
   and disconnects reset the baseline instead of counting as zeros. Event IDs look like
   `channel-<epoch>`, so a restart never creates duplicates.
4. **Extract** (`extractor.py`). Waits until enough post-spike footage exists, then stream-copies
   60 seconds before and 60 seconds after the spike. The copy has no re-encode, so the original
   quality and audio are kept. It writes `metadata.json`, `chat_context.json` (chat around the spike)
   and `frames/`.
5. **Transcribe** (`transcriber.py`). Runs `whisper-cli` and writes `transcript.srt` (clip-relative),
   `transcript.recording.srt` (on the recording's timeline), `transcript.json` and `words.json` with
   word-level timings. Nothing is burned into the video.
6. **Edit** (`editor.py`). Writes `data/jobs/<event>/EDIT_JOB.md` and runs Claude Code headless with a
   restricted tool list. Claude follows [`.claude/skills/edit-short/SKILL.md`](.claude/skills/edit-short/SKILL.md).
   It chooses the moment and layout, designs captions, motion and sound, renders with FFmpeg, and
   inspects the result. It writes `short.mp4`, `edit_decisions.json` and `description.txt`. A clip can
   also be rejected. The toolkit is `python -m clipwatcher.editkit`, with `captions`, `audiomix`,
   `trimgraph`, `inspect` and `library`.

   `finish` then checks that the Short fully decodes, is 9:16, is within the length limit, sits
   near -14 LUFS with true peak at or below -0.5 dB, uses only licensed audio and credits the
   streamer.
7. **Storage** (`storage.py`). Everything is produced on the internal drive first. Once an edit is
   finished, rejected or failed, the storage stage:
   1. fully decodes the raw clip and the edited Short;
   2. copies the raw-clip folder to the external drive under a `.partial` name, verifying SHA-256 on
      both sides of every file;
   3. decodes the copy, writes `checksums.sha256` and renames the folder into place;
   4. **only then** removes the local staging copy.

   Recordings are handled as follows:
   - **Deleted** only after the stream has ended (plus `settle_minutes`), every clip in it was
     extracted, and every raw clip is verified on the external drive.
   - **Kept** if any extraction failed, so you can fix it and `retry`.
   - **Moved** (and verified) to the external drive if they produced no clips.
   - **Offloaded** to the external drive if the internal disk runs low while work is still pending.

   If the external drive is unplugged, everything waits and nothing is deleted. Every move and
   deletion is recorded in the `storage_log` table.

## Output layout

```
<external>\Raw Cut Clips\<streamer>\<date>\<event>\     raw clips, verified backups
    clip.mp4, metadata.json, transcript*.srt, words.json, chat_context.json, frames\,
    checksums.sha256, editor_outcome.json (if the edit was rejected or failed)
<external>\Recordings\<streamer>\<session>.ts          recordings with no clips (kept)
<project>\Edited Clips\<streamer>\<date>\<event>\      finished Shorts only
    short.mp4, edit_decisions.json, description.txt, metadata.json, edit_log.json
<project>\data\                                        working area, safe to clear once backed up
    recordings\, chat\, raw_clips\, jobs\, logs\, clipwatcher.db
```

## Sound library

`make-assets` generates 15 sound effects and 4 music beds into `assets/`, and indexes them in
`assets/library.json`. To add your own licensed music or effects:

1. Drop the files into `assets/music/` or `assets/sfx/`.
2. Run `make-assets`.
3. Fill in each new item's `license` (and `credit`, if required) in `assets/library.json`.

Items with an unknown license are never used.

## Timing

Chat and video share one clock: the local receive time of each chat message and the local time of
each recording's first byte. If you measure a consistent drift, set `sync.chat_offset_seconds`.
Cuts snap back to the previous keyframe (Twitch uses 2-second GOPs) so that audio and video start
together. The exact source start is saved in each clip's metadata.

Streamlink 8+ always drops Twitch ad segments. A clip that spans an ad break will contain a jump.

## Attribution and terms

Every clip and Short carries the streamer name, the channel URL, the recording session, the source
timestamps and the detection event ID. Suggested descriptions credit and link the streamer.

Before you post anything, get the streamer's permission. Follow Twitch's Terms of Service, YouTube's
policies and copyright law, especially for music.

## Project layout

```
clipwatcher/      the pipeline (one module per stage, plus db, storage, editkit, soundlib)
.claude/skills/   the edit-short playbook that Claude Code follows
assets/           generated sound library (library.json is local and gitignored)
tests/            unit and integration tests
config.example.toml
```

## Tests

```bash
python -m unittest discover -s tests -v
```

Integration tests need `ffmpeg` and `ffprobe` and are skipped without them.

## Status

Tested live on Twitch: recording, chat capture, spike detection, extraction, transcription, Claude
edits and storage backups with verification. Not yet tested live: the low-disk rollover during a
real stream, and recordings that contain an ad break. Both are covered by unit tests only.
