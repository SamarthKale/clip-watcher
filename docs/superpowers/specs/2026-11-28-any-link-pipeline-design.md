# Any link in, Shorts out (Spikecut 1.1)

## Intent
The owner pastes any video link: a finished stream, a podcast episode, any ordinary YouTube upload.
Spikecut downloads it, finds the best moments and edits them into Shorts **without anyone pressing
Start or naming a Twitch channel**. Live watching stays exactly as it is.

## Decisions (owner, 2026-11-28)
- **Framing for talking videos:** follow the speaker (crop moves to whoever is talking).
- **Shorts per video:** chosen per link, default 5 (1-20).
- **Speech:** multilingual, language detected per clip (Hindi, English, Hinglish, others).
- **Links:** anything yt-dlp can download; DRM services fail with a clear message.
- 1.0.1 is folded into this release: one release, **1.1.0**, also carrying the OAuth guide.

## Goals
1. Adding a link starts the work by itself (and pending links resume when the app opens).
2. Any single-video link is accepted; playlists and live streams are refused with a readable reason.
3. Moments in videos with no chat come from the whole video, not just loud seconds.
4. Talking videos are edited in a talking style; gameplay videos keep the current style.
5. The owner's count per link caps how many Shorts are made from it.

## Non-goals / anti-goals
- No new dependencies, no paid APIs, no generated footage (CLAUDE.md).
- The plain chat detector stays the default trigger for live and for chat replays (at the owner's 1.8x).
- No speaker diarisation model; "who is talking" comes from the picture (motion) and Claude's read of the frames.
- Nothing is uploaded except through the app's upload module, in the owner's chosen mode.

## Approaches considered
| Approach | Trade-off | Verdict |
|---|---|---|
| **A. Scout pass: whole-video transcript + signal timeline, Claude picks moments** | Finds quiet moments (lines, reveals, stories); one extra Claude call per video; transcription time | **Chosen** |
| B. Loudness only (today's fallback) | Free and fast, misses everything said at normal volume | Kept as fallback only |
| C. Cut every N minutes and let the editor reject | No selection; burns Claude usage on every chunk | Rejected |

## Design
**Link intake (`vod.py`).** `parse_source` keeps the canonical Twitch/YouTube/Kick forms (plus
`youtube.com/shorts/<id>`) and accepts any other `http(s)` link as platform `web`. `probe` refuses
playlists and live streams. The stable ID for a `web` link comes from yt-dlp's own `id` after probing.
`vod_jobs` gets `max_shorts` (default 5, clamped 1-20).

**Auto-start (`ui.py`, `cli.py`).** `run --links-only` starts just `vodwork, extract, transcribe,
edit, storage`. The dashboard's runner starts it when a link is queued and nothing is running, and
when the dashboard opens with pending links. Pressing Start with a channel while links-only is
running switches to the full pipeline (it keeps working links). The status gets `mode: live|links`.

**Finding moments (`scout.py`).** For a video with no usable chat replay:
1. Transcribe the whole file with a fast multilingual model (`[scout] model`, default
   `models/ggml-base.bin`, language auto) into timed lines.
2. Summarise loudness per 30 s window (existing `signals.audio_scan`).
3. Ask Claude Code headless, with no tools, for the best N self-contained moments as JSON
   (start, end, title, reason, kind, score); transcripts longer than ~2.5 h are read in chunks
   and merged by score.
4. Validate: inside the video, 15-90 s long, no overlaps, at most N. Each becomes an event with
   `stats.source = "scout"` and its exact window.
Fallback when there is no speech or Claude fails: the loudness detector, capped at N.
Chat or loudness spikes are capped at N too, strongest first.

**Extract and edit.** A scout event is cut at its own window plus 15 s on each side (not the
fixed 75 s). EDIT_JOB describes the scout's pick and tells the editor the moment was pre-chosen.
The skill gets `references/talking-video.md` (follow-the-speaker crop, captions, little SFX,
hook-first) and the playbook routes non-gameplay footage there. `editkit speakerpath --keys
t:x,...` turns speaker turns into the crop's x expression; `editkit track` can find them.

**Speech models.** The installer ships `ggml-large-v3-turbo-q5_0.bin` (clip captions, multilingual)
and `ggml-base.bin` (scout), replacing `ggml-base.en.bin`. A work folder whose `config.toml` still
has the exact model/language lines Spikecut 1.0 wrote is upgraded once; any other config is left alone.

**UI.** "Add a VOD" becomes "Add a video": any link, a Shorts-per-video number, per-link status
("downloading", "transcribing", "finding moments", "N moments") and a note that work starts by itself.

## Left to the builder
Exact prompt wording, chunk sizes, status strings, layout of the page.
