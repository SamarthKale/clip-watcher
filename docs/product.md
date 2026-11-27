# Spikecut: the desktop product

*Catch the spike. Cut the Short.*

One app that records a stream (or takes a link to a finished one), finds the best moments, edits
Shorts with Claude, writes the title, description and tags, and uploads them to YouTube after you
approve them (or automatically, if you choose). It opens in a light, see-through glass window.

## Start it

```bash
cd app
npm run desktop        # builds the UI and opens the window
```

or double-click `Spikecut.cmd` in the project folder. The window starts the clipping pipeline's
local API and the upload server itself, and stops them when you close it. If the pipeline is still
watching a channel when you close the window, you are asked whether to stop it or keep it recording.

Needs: Node 20+, Python 3.11+, and the tools listed under Home -> "Setup needed" if any is missing
(streamlink, ffmpeg, whisper.cpp with its speech model, yt-dlp, Claude Code).

## Brand

| | |
|---|---|
| Name | Spikecut (internal names such as the `clipwatcher` package and data folders are unchanged) |
| Mark | A chat-activity line that shoots up into a spike, cut by a diagonal slash, on a violet tile with a coral "live" dot. Source: `app/build/icon.svg`; `npm run icons` renders the PNG and `.ico` files. |
| Colours | Spike violet `#6a3df5` (actions, focus), coral `#ff5a5f` (live only), quiet greys for everything else |
| Type | Segoe UI Variable (built into Windows 11) |
| Motion | The Motion library: page transitions, staggered cards, counters, the live ripple, the drawing logo on the splash screen. All of it is off when Windows "Animation effects" is off. |

## First run and the tour

The first time the app opens, a guided tour walks through every page: what Spikecut does, the five
stages, and each page in the sidebar (each step opens that page and points at it). It ends with four steps
to a first Short. Finishing or skipping it is remembered (`tourSeen` in the upload server's settings);
**Take the tour** in the sidebar and in Settings opens it again.

## How the pieces fit

```
 Electron window (sandboxed React UI, glass theme)
        |  only talks to
 Node app server  (app/src/server, port chosen at start, token + cookie locked)
   - uploads, review, YouTube account, upload history, publish mode
   - /api/pipeline/*  ->  fixed allow-list proxy to the Python API
        |
 Python pipeline API  (python -m clipwatcher ui, 127.0.0.1 only)
   - starts and stops `python -m clipwatcher run` (record, chat, detect, extract, transcribe,
     edit, storage, vodwork)
   - VOD links, watch list, Claude usage, storage manager
```

Finished Shorts are published into the library folder (`Shorts/<date>/<channel>__live|vod/`):

```
01_slug.mp4   01_slug_cover.jpg   01_slug_thumb.jpg   clips.json   POST.md
```

`clips.json` (schema 2) carries the Claude-written title, description, hashtags, tags, keywords and the
TikTok / Shorts / Reels captions, plus the source, attribution and Claude usage. The upload server
watches that folder automatically (no folder picking), and writes each Short's upload state back into
`clips.json` (`upload: {status, youtube_video_id, ...}`) so the storage manager knows what is safe to remove.

## Publishing modes (Settings -> Publishing)

| Mode | What happens to a new Short |
|---|---|
| Review first (default) | Waits in Review & publish. You watch it, edit the text, approve it. |
| Auto-publish | Uploads by itself with the chosen visibility (private / unlisted / public). |

Changing the mode only affects Shorts that are not queued yet. YouTube's own daily upload and API
limits still apply; the app pauses and says why instead of trying to get around them. Uploads are
resumable, one at a time, and are never repeated after an uncertain result.

## Subtitles

Speech is transcribed with a multilingual model and the language is detected per clip (English, Hindi,
Hinglish). Captions are always shown in Latin letters: English stays English, Hindi and mixed speech
become Hinglish ("bhai ye dekh"). Claude refines the spelling (`romanized.json`); anything it misses is
transliterated automatically so raw Devanagari never reaches a caption.

## Storage

Storage shows what takes space and offers a preview before any cleanup. Deleting is always an explicit
action, and each item is checked again at the moment it is deleted:

- a recording goes only when every clip from it is cut, backed up and its Shorts are uploaded or discarded
- a Short goes only when it is uploaded or discarded
- a working raw clip goes only when a verified backup exists (never overridable)
- items that are not safe can be forced one by one, with a clear warning

## Claude usage

Every edit attempt, including failed and rejected ones, is recorded (tokens, turns, time, list-price
cost) and shown per video, per stream and per day. A per-clip spend cap (`edit.max_spend_usd`) stops
retries on a clip that keeps failing.

## Limits and honest caveats

- The glass effect is Windows 11 acrylic in its light tint: it blurs and brightens what is behind the window. It is not a fully clear window.
- Hinglish transcription runs on the CPU here: about 45 s per minute of audio with the large model.
  A speech-to-text line that Whisper writes in the wrong script is repaired by the transliteration, not
  perfected; read the first few captions of a new streamer.
- Twitch and Kick VODs have no chat replay, so their spikes come from loud moments; YouTube streams use
  their chat replay.
- Not done yet (needed before giving the app to other creators): a Windows installer, bundling Python
  and the external tools, a first-run download wizard, code signing, and the Google OAuth verification
  and YouTube API compliance audit (without it, a project is limited to roughly 6 uploads a day and
  uploads may be forced private). Check Anthropic's terms for running Claude Code inside an app you
  distribute, and decide whether each creator brings their own Google OAuth client.
