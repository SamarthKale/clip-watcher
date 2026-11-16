# Clip Watcher

Records a Twitch channel and finds chat spikes. For each spike it cuts generous raw footage and
transcribes it, then hands it to Claude Code to edit into a vertical YouTube Short.
It's Python 3.11+ and uses only the standard library. The external tools are streamlink,
ffmpeg/ffprobe, whisper.cpp (`whisper-cli`) and Claude Code.

## Pipeline (one process per stage, `python -m clipwatcher run --channel X` starts them all)
1. `record`: `recorder.py` runs streamlink and writes one read-only `.ts` per live session.
   `start_wall` is the time of the first byte.
2. `chat`: `chat.py` reads anonymous TLS IRC (and falls back to the user's own OAuth) into
   `data/chat/<channel>/chat.log` as JSONL. It never sends messages.
3. `detect`: `detector.py` counts messages in 10 s buckets, takes the mean of the previous 5 min,
   flags buckets at ≥3x, and queues events. The optional `audiodetect` stage (`audio_detector.py`, off
   by default) does the same on recording loudness. A spike near an existing event from another
   detector is merged into it (`db.add_event(merge_window=...)`).
4. `extract`: `extractor.py` stream-copies 60 s before and 60 s after the spike into
   `data/raw_clips/<event>/`, along with frames, chat context, metadata and `signals.json`
   (`signals.py`: loudness peaks, silences, scene changes, chat categories, triage score).
5. `transcribe`: `transcriber.py` runs whisper.cpp and writes SRTs (clip- and recording-relative)
   and `words.json`.
6. `edit`: `editor.py` writes `data/jobs/<event>/EDIT_JOB.md`. Claude follows
   `.claude/skills/edit-short/SKILL.md` and its `references/`, the gaming skill pack described in
   `docs/skill-pack.md`. It uses `editkit.py` (captions, audio mix, reframe, track, timeline, grid,
   snap, thumbnail, QA; layouts live in `reframe.py`) and the licensed sound library in `assets/`
   (`soundlib.py`). It writes to `Edited Clips/<streamer>/<date>/<event>/`. `finish` runs the QA gate,
   then renders `final/` (thumbnail and cover via `thumbs.py`, platform files via `export.py`).
7. `storage`: `storage.py` verifies the raw and edited clips, backs up raw clips to the external
   drive (SHA-256-verified), and deletes a recording only after all its clips are verified and
   backed up. Recordings with no clips are moved to the external drive and kept.

Queues live in SQLite (`data/clipwatcher.db`, `db.py`). Each stage has its own queue with a lease,
retries and backoff.

## Rules
- Never modify `data/recordings/` or `data/raw_clips/`. Never publish anything.
- Never delete a recording or intermediate file until its clips are generated, verified and backed
  up. All deletions go through `storage.py`, and the current editing approach is the baseline.
- Only use audio from `assets/library.json` with a known license.
- Every Short keeps its attribution: streamer, channel URL, session, source timestamps and event ID.
- Keep the stages separate. The plain 3x detector stays the default, and the audio trigger stays opt-in.
- No new dependencies: ffmpeg, whisper.cpp and the standard library only. No paid APIs, and no
  generated footage.

## Tests
`python -m unittest discover -s tests -v`
