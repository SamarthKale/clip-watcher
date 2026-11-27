# One Product: Clip Watcher + Uploader — Roadmap

> **For agentic workers:** this is a roadmap of eight phases, each its own sub-project. Before a
> phase is built, write its task-level plan (superpowers:writing-plans) in
> `docs/superpowers/plans/` and execute that with superpowers:subagent-driven-development or
> superpowers:executing-plans. Do not implement straight from this file.

**Goal:** Turn Clip Watcher (Python pipeline + dashboard) and the Uploader (D:\Uploader, Node/TypeScript
"LocalTube") into one desktop product creators can install: it records or ingests streams, finds the
moments, edits Shorts with Claude Code, writes SEO text, and uploads to YouTube in review-first or
auto-publish mode, in a see-through glass window.

**Architecture:** One repository (this one). The Python pipeline stays as it is (`clipwatcher/`).
The Uploader's tested TypeScript server and React UI move into `app/` with their git history. An
Electron shell owns the window (Windows acrylic, transparent) and supervises two child processes:
the Node server (uploads, UI, API) and the Python pipeline. The UI talks only to the Node server;
the Node server proxies pipeline calls to the Python dashboard API on 127.0.0.1.

**Tech stack:** Python 3.11+ stdlib; Node 20+, TypeScript, Fastify, better-sqlite3, React, Vite,
Tailwind (all already in the Uploader); Electron; external tools ffmpeg/ffprobe, whisper.cpp,
streamlink, yt-dlp, Claude Code CLI.

**Spec:** the decisions below, made with the owner on 2026-11-27 (no separate spec document).

## Decisions (from the owner)

| Topic | Decision |
|---|---|
| Uploader | Merge the code into one product, carefully: reuse the tested Uploader code, don't rewrite it |
| App shell | Electron, keeping both languages. Must be shippable to other creators later |
| Window | Truly see-through: real desktop visible behind frosted glass (acrylic) |
| Output format | The older clipper's layout: `NN_slug.mp4`, `NN_slug_cover.jpg`, `clips.json`, `POST.md` per stream folder |
| Thumbnails | Keep Clip Watcher's thumbnail and cover generation (`thumbs.py`) |
| Text | Claude only (the editor writes it while editing). No Gemini in the product path. Richer, SEO-focused title, description and hashtags |
| Per-platform text | Yes: separate TikTok / Shorts / Reels captions and a `POST.md` per stream |
| Publishing | Two modes: **Review first** (interactive review panel) and **Auto-publish** |
| Folders | No manual folder picking: every output folder the pipeline creates is detected automatically |
| Storage | A clear storage manager to delete old clips and recordings |
| Usage | Dashboard shows Claude usage per video (tokens, cost, attempts) and totals |
| Subtitles | Auto-detect Hindi / English / Hinglish; Hindi and mixed speech written in Latin script ("bhai ye dekh"), English as English |
| VOD intake | Paste a VOD link after a live ends: Twitch, YouTube and Kick |
| Watch list | A streamer list that finds their recent VODs and clips them |

## Global Constraints

- The project rules in `CLAUDE.md` change in Phase 0 and the new text is binding from then on:
  publishing is allowed **only** through the upload module, in the mode the user set; nothing else
  in the codebase may publish.
- New dependencies are limited to: Electron (+ electron-builder for packaging), the Uploader's
  existing npm dependencies, and the external tools yt-dlp and a multilingual whisper model. Any
  other new dependency needs the owner's approval first.
- Never modify `data/recordings/` or `data/raw_clips/` outside `storage.py`; never delete a recording,
  raw clip or Short until it is verified and backed up, and (for Shorts) uploaded or explicitly
  discarded by the user. All deletions go through `storage.py`, including the storage manager's.
- Every Short keeps its attribution (streamer, channel URL, session, source timestamps, event ID) in
  `clips.json`, `POST.md` and the YouTube description.
- Only licensed audio from `assets/library.json`.
- No product-specific game or event is named in code, docs, defaults, commits or generated text
  unless it comes from the stream itself. Keyword filters are user settings, empty by default.
- One upload at a time, resumable, never re-uploaded after an uncertain result (the Uploader's
  existing guarantees stay intact and its tests keep passing).
- All text files are UTF-8 (Hinglish and Devanagari must survive Windows code pages).
- Secrets stay server-side (Windows DPAPI, as the Uploader does today); the UI never sees tokens.
- `python -m unittest discover -s tests -v` and `npm test` (in `app/`) both pass after every task.

## Review Focus

1. **A crash or disconnect mid-upload.** Expect no duplicate upload and no lost job (the Uploader's
   resumable-session logic must survive the move; Phase 6 re-runs its fake-YouTube tests).
2. **The storage manager deleting something not yet backed up or not yet uploaded.** Expect it to
   refuse, show why, and require an explicit per-item override (Phase 7 test).
3. **Hindi or emoji in titles, file names and JSON on Windows.** Expect clean UTF-8 everywhere and
   ASCII-safe file slugs (Phase 1 and 3 tests).
4. **The D: drive (data root) disappearing mid-stream.** Expect stages to pause and resume, never to
   write to C: silently (Phase 5 supervisor test).
5. **A clip whose edit keeps failing.** Expect attempts and spend to be capped and visible in Usage,
   with Skip/Retry (Phase 2 test).

---

## Phase 0: Groundwork (one repo, new rules)

- Merge the open branch `fix-keyframe-and-skip` (PR) into `main`.
- Import `D:\Uploader` into `app/` **with history** (`git subtree add --prefix=app`), leaving
  `D:\Uploader` untouched until the product replaces it.
- Point the Uploader's data dir at `data/uploader/` (`LOCALTUBE_DATA`), so one data root holds
  everything.
- Update `CLAUDE.md` rules to the Global Constraints above; one script runs both test suites.

**Done when:** both suites pass from the one repo; the Uploader still runs from `app/` with its own
UI exactly as before.

## Phase 1: Output layout, SEO text, per-platform captions (Python)

- New `clipwatcher/export.py` step after `finish`: copies (never moves) each finished Short into
  `Edited Clips/<date>/<streamer>__<live|vod>/NN_slug.mp4` + `NN_slug_cover.jpg`, and rewrites that
  folder's `clips.json` and `POST.md` atomically.
- `clips.json` entry keeps the Uploader-compatible fields (`file`, `cover`, `post_title`,
  `description`, `hashtags`, `hook_text`, `caption`, `captions{tiktok,shorts,reels}`, `score`,
  `reason`, `stream_start`, `stream_end`, `duration`, `spike`) and adds `event_id`, `attribution`,
  `keywords`, `language`, `usage`, `schema: 2`.
- The edit skill and job brief require Claude to write the SEO block into `edit_decisions.json`:
  title ≤ 100 characters, keyword first, no clickbait claims the clip doesn't show; description with a
  2-line hook, context, credit line and 3–5 hashtags; tags ≤ 500 characters total; the three
  platform captions. `finish` validates the limits.
- Slugs are ASCII, numbered per stream folder, stable across rewrites.

**Done when:** a finished Short appears in the new layout with a valid `clips.json` that the
Uploader's own manifest parser (`app/src/server/manifest/manifest.ts`) accepts (cross-language test).

## Phase 2: Claude usage per video (Python)

- Keep every edit attempt's output (`data/jobs/<event>/claude_runs/attempt-N.json`); today each
  attempt overwrites the last.
- New SQLite table `edit_usage(event_id, attempt, model, input_tokens, cache_read, cache_write,
  output_tokens, cost_usd, turns, duration_ms, outcome, created)`, filled after every attempt,
  including failed and rejected ones.
- Dashboard API: per video (all attempts summed), per stream, per day, average per finished Short.
  Cost is labelled "list-price equivalent" (on a subscription it counts against usage limits).
- Cap: `edit.max_attempts_spend_usd` stops retrying a clip past a spend limit.

**Done when:** the Usage view shows the already finished Shorts with their real
numbers, and failed attempts are counted.

## Phase 3: Hinglish subtitles (Python)

- Multilingual whisper model (start with `ggml-large-v3-turbo-q5_0`, about 550 MB; fall back to
  `ggml-medium`), language auto-detected per clip and stored in `words.json`.
- Claude writes captions in Latin Hinglish for Hindi and mixed speech, English as spoken: the edit
  step produces `romanized.json` (word index → Latin text); `editkit captions` renders from it.
- A deterministic Devanagari→Latin fallback for any word Claude didn't map, so captions never
  show raw Devanagari by accident.

**Done when:** a Hindi/Hinglish test clip yields Latin captions, an English clip is unchanged, and the
CPU transcription time per 150 s clip is measured and recorded.

## Phase 4: VOD links and watch list (Python)

- `python -m clipwatcher vod <url>`: Twitch VODs via streamlink; YouTube and Kick via yt-dlp.
  The VOD becomes a normal recording session, so extract → transcribe → edit → export run unchanged.
- Spikes for a VOD: chat replay where yt-dlp provides it (YouTube live chat replay; Twitch rechat if
  it still works — verify), otherwise the audio-loudness detector, which is switched on for VODs.
- Watch list: channels (Twitch / YouTube / Kick) with an optional title keyword filter and a
  look-back window; yt-dlp lists new VODs; each is ingested once.

**Done when:** one Twitch, one YouTube and one Kick VOD link each produce clips end to end.

## Phase 5: The app shell (Electron, see-through glass)

- `app/electron/`: main process creates a frameless, transparent window with Windows acrylic
  (`backgroundMaterial: 'acrylic'`), loads the React UI from the Node server.
- Supervisor: starts the Node server and the Python pipeline API; restarts them; shows their state;
  pauses cleanly if the data drive disappears.
- One React UI: the Uploader's pages plus Clip Watcher's (Home with live chat and spike line,
  Spikes & clips with Skip/Retry, Shorts player, Live log, Usage), restyled as glass panels.
- The Python `ui.py` dashboard stays as the pipeline API (its HTML page can be retired later).

**Done when:** one double-click opens the glass window, Start watching works, and every current
dashboard feature works inside it.

## Phase 6: Uploads inside the product

- On startup the export root (`Edited Clips/`) is registered once as a recursive watched folder; new
  stream folders are found automatically, no folder picker.
- Text comes from `clips.json` only (Claude). The Gemini path is switched off and hidden in the
  product; the Uploader's "user edit wins" and "restore original" rules stay.
- **Review first** (default): a Review panel with the video player, editable title / description /
  hashtags, visibility, schedule, approve or reject, and bulk approve.
- **Auto-publish**: per channel, with the chosen visibility.
- Uploaded/published state is written back to `clips.json` and the Shorts view.

**Done when:** a Short goes from finished to uploaded in each mode against the Uploader's fake
YouTube server in tests, and once for real to a private video.

## Phase 7: Storage manager

- One view: recordings, raw clips (local and backup), exported Shorts, work folders, with size, age,
  backed-up and uploaded status.
- Rules such as "delete recordings and raw clips older than N days once all their Shorts are
  uploaded"; every run shows a preview (what, how much space) and needs confirmation.
- Refuses anything not backed up or not uploaded unless overridden per item; all deletions go through
  `storage.py` and are logged in `storage_log`.

**Done when:** the preview matches what is deleted, and the refusal cases are covered by tests.

## Phase 8: Shipping to creators

- electron-builder Windows installer; per-user data root chosen at first run (any drive).
- First-run wizard: tools check and download (ffmpeg, whisper + model, streamlink, yt-dlp),
  Claude Code installed and signed in, Google account connected.
- Licenses screen; ship an LGPL ffmpeg build; code-signing certificate for SmartScreen.
- **Verify before shipping (not decided here):** Google OAuth verification and the YouTube API
  compliance audit (default quota allows about 6 uploads a day per project); whether each creator
  brings their own Google OAuth client or the product uses one verified project; Anthropic's terms for
  running Claude Code headless inside a distributed app, with each creator's own account.

**Done when:** a clean Windows machine goes from installer to a first uploaded Short following only
the wizard.

---

## Order and dependencies

Phases 1, 2, 3 and 4 are Python-only and independent of each other; they can be built in any order
or in parallel. Phase 5 needs Phase 0. Phase 6 needs Phases 1 and 5. Phase 7 needs Phase 6 (it uses
upload status). Phase 8 comes last.

Recommended start: **Phase 0, then Phase 1** (the new layout and SEO text are visible immediately in
the next stream, and Phase 6 depends on them).
