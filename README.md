# Clip Watcher

Clip Watcher watches a Twitch channel and finds the moments chat goes wild. It cuts raw footage
around each moment and transcribes it, then hands it to **Claude Code**, which edits it into a
vertical YouTube Short.

```
STREAM GOES LIVE -> STREAMLINK RECORDING -> TWITCH IRC CHAT -> 10s CHAT BUCKETS
 -> 5-MIN ROLLING AVERAGE -> 3x SPIKE -> RAW FOOTAGE (60s+60s) -> WHISPER TRANSCRIPT
 -> CLAUDE CODE EDIT QUEUE -> CREATIVE ANALYSIS -> FFMPEG RENDER -> EDITED CLIPS (internal)
 -> VERIFIED BACKUP OF RAW CUT CLIPS (external) -> SAFE CLEANUP OF RECORDINGS
```

Each stage runs as its own process and has its own persistent queue in SQLite, so transcription
or editing can never block recording or chat capture. A stage that crashes is restarted. A job it
was working on is reclaimed once its lease expires, and failed jobs are retried with backoff.

## Install

1. Python 3.11+ (the code uses only the standard library).
2. External tools, on PATH or configured in `config.toml`:
   - **streamlink**: `pip install streamlink`
   - **ffmpeg + ffprobe**: e.g. `winget install Gyan.FFmpeg`
   - **whisper.cpp** `whisper-cli`, plus a model at `models/ggml-medium.en.bin`
     (<https://github.com/ggml-org/whisper.cpp>; models at <https://huggingface.co/ggerganov/whisper.cpp>)
   - **Claude Code** `claude`, for automatic editing
3. Optionally, `copy config.example.toml config.toml` and edit it. If a tool isn't on PATH, set
   its full path there (`record.streamlink`, `extract.ffmpeg`, `extract.ffprobe`,
   `transcribe.whisper_cli`). On this machine, `pip install streamlink` put the binary in
   `%APPDATA%\Python\Python313\Scripts\`, and FFmpeg is in `tools\ffmpeg\`.
4. `python -m clipwatcher make-assets` generates the original sound library in `assets/`.
5. `python -m clipwatcher check` reports anything that's missing, plus storage-drive status.

## Run

```bash
python -m clipwatcher run --channel <twitch_channel>
```

The channel always comes from your input (`--channel`, or `channel` in `config.toml`). Nothing is
hardcoded. You can also run each stage on its own, e.g. `python -m clipwatcher record --channel X`.

| Command | What it does |
|---|---|
| `run` | all stages, supervised (`--for 600` stops gracefully after 10 minutes) |
| `record` / `chat` / `detect` | steps 1–3 for one channel |
| `extract` / `transcribe` / `edit` | queue workers for steps 4–6 |
| `storage` | step 7: verified backups to the external drive and safe cleanup |
| `make-assets` | generate / re-index the sound library (`--force` regenerates) |
| `status` | sessions, queue counts, recent jobs and errors |
| `retry <event_id> <stage>` | re-queue a failed or skipped job |
| `detect-file <chat.log>` | run the detector over an existing log (`--enqueue` to queue the results) |
| `next-edit` | editing jobs waiting for a manual Claude session |
| `finish <event_id>` | validate a Short and write its attribution metadata |

## The stages

1. **Record** (`recorder.py`) runs `streamlink twitch.tv/CHANNEL best -o <session>.ts --retry-streams 30`
   in a loop. It waits for the channel to go live and records continuously. On every disconnect it
   starts a new session file. Quality is configurable. The local time of the first byte becomes the
   session's timeline origin. Recordings are never modified and are marked read-only once they end.
2. **Chat** (`chat.py`) connects to `irc.chat.twitch.tv:6697` over TLS, anonymously as
   `justinfanNNNNN`, and joins `#channel`. If Twitch refuses anonymous access it uses your own
   account (`chat.username` and `chat.oauth_token`, `chat:read` scope only). It reconnects
   automatically and writes `chat.log` (JSON Lines) with messages, connect/disconnect markers and
   5-second heartbeats. It is read-only by construction: only CAP/PASS/NICK/JOIN/PING/PONG can
   ever be sent.
3. **Detect** (`detector.py`) is the original algorithm and the default. It counts messages in
   10 s buckets, takes the mean of the **previous** 5 minutes (never including the bucket being
   tested), and flags a spike at ≥ 3x. Insufficient history is ignored. The baseline is floored
   so dead or near-empty chat can't trigger, and a spike also needs a minimum message count.
   Consecutive spike buckets merge into one event, followed by a cooldown. Disconnects and silent
   gaps reset the baseline rather than counting as zeros. Event IDs are deterministic
   (`channel-<epoch>`), so a restart never produces duplicates.
4. **Extract** (`extractor.py`) waits until 60 s of post-spike footage exists. It then stream-copies
   60 s before and 60 s after the spike (`ffmpeg -ss … -i session.ts -t … -c copy`), which keeps the
   original quality and audio. It writes `metadata.json` (attribution, session, source timestamps,
   spike stats), `chat_context.json` and representative `frames/`.
5. **Transcribe** (`transcriber.py`) runs `whisper-cli` and writes `transcript.srt` (clip-relative),
   `transcript.recording.srt` (on the original recording's timeline), `transcript.json` and
   `words.json` (word-level timings). Nothing is burned in.
6. **Edit** (`editor.py`) writes `data/jobs/<event>/EDIT_JOB.md` with everything Claude needs.
   - With `edit.mode = "claude"` (the default), it runs `claude -p` headless with a restricted tool
     list.
   - With `"manual"`, open Claude Code in this folder and run `/edit-short`.

   Claude follows [`.claude/skills/edit-short/SKILL.md`](.claude/skills/edit-short/SKILL.md). It
   analyzes the moment, picks the segment and duration, chooses the vertical layout, designs the
   captions, motion and sound design, renders with FFmpeg and inspects the render. It works from
   a beat sheet: hook, context, build, payoff, reaction, then a hard out that loops. It then saves
   `short.mp4`, `edit_decisions.json` and `description.txt` to the Edited Clips library, and can
   reject unusable clips. `finish` checks that the Short fully decodes, is 9:16, within length,
   about -14 LUFS with true peak ≤ -0.5 dB, uses only licensed audio, and credits the streamer
   and any audio. It then writes the attribution `metadata.json`.

   **Editing toolkit** (`python -m clipwatcher.editkit …`), used by Claude:
   - `captions`: animated, word-highlighted ASS captions, remapped through jump cuts, with slurs
     masked.
   - `audiomix`: cleaned voice, a music bed ducked under speech with optional drop-outs, and timed
     sound effects, normalized to -14 LUFS.
   - `trimgraph`, `inspect` (decode, loudness and contact-sheet QA) and `library`.

   **Sound library** (`assets/`): 15 sound effects and 4 music beds, synthesized from scratch by
   `make-assets`. They are original and CC0, so they're safe from Content ID. To add licensed
   tracks, such as YouTube Audio Library music:
   1. Drop the files into `assets/music/` or `assets/sfx/`.
   2. Run `make-assets`.
   3. Fill in each new item's `license` (and `credit`, if attribution is required) in
      `assets/library.json`.

   Items with an unknown license are never used.
7. **Storage** (`storage.py`). Everything is produced on the internal drive first. Once a clip's
   edit is finished (done, rejected or failed), the storage stage:
   1. fully decodes the raw clip and the edited Short;
   2. copies the raw-clip folder to the external drive under a `.partial` name, SHA-256-verifying
      every file on both sides;
   3. decodes the copy, writes `checksums.sha256` and renames the folder into place;
   4. **only then** removes the local staging copy and temporary files.

   A rejected or failed edit's notes go with the raw clip as `editor_outcome.json`, so Edited Clips
   holds finished Shorts only.

   **Recordings:**
   - **Deleted** only after the stream has ended (plus `settle_minutes`), every clip in it was
     extracted, and every raw clip is verified on the external drive.
   - **Kept forever** if any extraction failed, so you can fix it and `retry`.
   - **Recordings with no clips** are moved (verified) to `D:\ClipWatcher\Recordings` and kept.
   - **Low internal disk:** below `record.rollover_below_gb` the recorder closes the current file
     and continues in a new one, a gap of a few seconds. Ended recordings with work still pending
     are moved (verified) to the external drive, and extraction continues from there. Below
     `record.min_free_gb`, recording pauses.
   - **External drive unplugged:** everything waits and nothing is deleted. Every move and
     deletion is logged in the `storage_log` table.

## Storage layout
```
D:\ClipWatcher\Raw Cut Clips\<streamer>\<date>\<event>\   RAW CUT CLIPS (external)
    clip.mp4, metadata.json, transcript*.srt, words.json, chat_context.json, frames\,
    editor_outcome.json (if rejected/failed), checksums.sha256
C:\clipper\Edited Clips\<streamer>\<date>\<event>\         EDITED CLIPS (internal)
    short.mp4, edit_decisions.json, description.txt, metadata.json, edit_log.json
D:\ClipWatcher\Recordings\<streamer>\<session>.ts           recordings with no clips (kept)

C:\clipper\data\                                             working area (internal)
    recordings\<channel>\<session>.ts    live/pending recordings (deleted once their clips are backed up)
    chat\<channel>\chat.log              JSONL chat log
    raw_clips\<event>\                   staging until backed up
    jobs\<event>\                        EDIT_JOB.md + Claude run logs (temporary)
    clipwatcher.db                        sessions, events, queues, storage_log
    logs\                                 one log per stage
```
The paths are set under `[storage]` in `config.toml`. Leave `raw_clips_dir` empty to keep
everything local: then nothing is backed up and no recording is deleted.

## Timing
Chat and video share one clock: the local receive time of each chat message, and the local time
of the recording's first byte. If you measure a consistent drift, set `sync.chat_offset_seconds`.
Stream-copy cuts are snapped back to the previous keyframe (Twitch uses 2 s GOPs) so audio and
video start together, and the exact source start is recorded in each clip's metadata.
Streamlink 8+ always drops Twitch ad segments. Clip timing still holds, because ffmpeg seeks by
the stream's own timestamps, which continue straight past a dropped ad. A clip that spans an
ad break will contain a jump.

## Attribution and terms
Every raw clip and Short carries the streamer name, the channel URL, the recording session, the
source timestamps and the detection event ID. Suggested descriptions always credit and link the
streamer. **Nothing is ever uploaded or published automatically.** Get the streamer's permission
before you post their content, and follow Twitch's Terms of Service, YouTube's policies and
copyright law (music in particular).

## Tests
```bash
python -m unittest discover -s tests -v
```
