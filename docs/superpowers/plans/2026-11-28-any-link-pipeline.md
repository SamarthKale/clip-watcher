# Any-link pipeline (Spikecut 1.1) Implementation Plan

**Goal:** Any pasted video link is downloaded and turned into up to N Shorts without pressing Start.
**Spec:** `docs/superpowers/specs/2026-11-28-any-link-pipeline-design.md`
**Tech:** Python 3.11+ stdlib (pipeline), React/TS (app), whisper.cpp, yt-dlp, Claude Code CLI.

## Global constraints
- No new dependencies; no paid APIs. All text UTF-8; slugs ASCII. Don't name a specific game, event or creator.
- Never modify `data/recordings/` or `data/raw_clips/` outside their stages. Never overwrite a user's config
  except the exact lines Spikecut 1.0 itself wrote.
- Tests: `python -m unittest discover -s tests -v` and `npm test` / `npm run test:ui` in `app/`.

## Review focus
1. A link added while a channel is being watched is worked by that run (no second runner).
2. A link that yt-dlp can't read, a playlist, or a live stream fails with a readable reason and never retries forever.
3. Claude returning junk (prose, bad times, overlaps, too many) never creates bad events; fallback is loudness.
4. A 3-hour video doesn't overflow one Claude call (chunking).
5. An existing 1.0 work folder keeps working after the model swap (config upgrade or fallback).

### Task 1: Links (`vod.py`, `db.py`) - test `tests/test_vod_links.py`
- `parse_source`: youtube `/shorts/<id>`; any other http(s) URL -> `{"platform": "web", "video_id": None, "url": <url without fragment>}`; non-http -> VodError.
- `probe`: `_type == "playlist"` -> VodError("...one video..."); live -> existing error.
- `vod_jobs.max_shorts INTEGER NOT NULL DEFAULT 5` (migration); `add_job(db, url, source="manual", max_shorts=5)` clamps 1-20.
- `ingest`: web links take `video_id` from `info["id"]` (sanitised); events from every detector go through `cap(candidates, n)` (strongest first).

### Task 2: Links-only run and auto-start (`cli.py`, `ui.py`) - tests `tests/test_links_mode.py`
- `run --links-only` -> stages `vodwork, extract, transcribe, edit, storage` (`stages_for(cfg, links_only)`).
- `Runner.start_links()`; `/api/vod/add` calls it when something was queued and nothing runs; dashboard start-up calls it when pending links exist; `start(channel)` while links-only switches over.
- status: `mode: "live" | "links" | None`.

### Task 3: Scout (`scout.py`, `config.py`) - test `tests/test_scout.py`
- `transcript_lines(segments) -> list[str]`, `loudness_windows(series, window=30) -> list[dict]`,
  `chunks(lines, max_chars)`, `build_prompt(meta, lines, loud, n) -> str`,
  `parse_moments(text, duration, n) -> list[dict]` (JSON in prose/code fence, clamps, 15-90 s, no overlaps, top-n by score),
  `find_moments(cfg, video, duration, n, run=..., claude=...) -> list[dict]`.
- `[scout]` config: enabled, model, language, threads, timeout_seconds, max_chars.
- `vod.ingest` uses scout when no chat; falls back to loudness.

### Task 4: Extract and edit (`extractor.py`, `editor.py`) - tests in `tests/test_scout.py`
- scout event (`stats.window`) cuts `[start-15, end+15]`; EDIT_JOB spike text for `source == "scout"`.

### Task 5: Talking style (skill + `editkit speakerpath`) - test `tests/test_speakerpath.py`
- `editkit speakerpath --source W --keys "0:120,6.5:900"` prints the crop x expression (uses `reframe.x_expression`).
- `references/talking-video.md`; SKILL.md routes non-gameplay footage to it.

### Task 6: Models, UI, version
- `stage_resources.py`: ship `ggml-large-v3-turbo-q5_0.bin` + `ggml-base.bin`, drop `ggml-base.en.bin`.
- `workfolder.cjs`: new folders get the turbo model + `language = "auto"`; 1.0 lines upgraded once (vitest).
- Vod page: "Add a video", Shorts-per-video field, statuses (Playwright test).
- version 1.1.0, README/product docs.

### Task 7: Ship
- Full tests, `npm run dist`, install over 1.0, smoke the installed app, merge, tag and release v1.1.0.
