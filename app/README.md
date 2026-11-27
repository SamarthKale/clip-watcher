# LocalTube

A local web app that watches folders of finished gameplay Shorts, writes a hook-style title, description and hashtags for each one with Gemini (from frames of the actual video), and uploads them to your YouTube channel through a durable, crash-safe queue.

Your videos never leave your computer except to YouTube itself. Only a few small still frames per video are sent to Gemini, and only if you switch that on.

## What you need

| Requirement | Notes |
| --- | --- |
| Windows 10/11 (64-bit) | Folder picker and credential encryption use Windows APIs. |
| Node.js 20+ | Developed on Node 24. |
| FFmpeg and FFprobe | On `PATH`, or set `FFMPEG_PATH` / `FFPROBE_PATH`. `winget install Gyan.FFmpeg` works. |
| A Gemini API key | From Google AI Studio. **A Gemini/Google/Claude/ChatGPT subscription is not an API key.** |
| A Google Cloud OAuth client | See below. |

## First run

```powershell
.\scripts\start.ps1      # or: npm install ; npm start
```

The app opens in your browser at `http://127.0.0.1:4317`. It only listens on your own computer.

1. **Settings** — paste your Gemini API key, tick the consent box (this is what allows frames to be sent to Google), save.
2. **Accounts & Channels** — paste your Google OAuth client ID, click *Connect Google account*, sign in, then **confirm the channel** shown. Nothing uploads until a channel is confirmed.
3. **Folders** — *Add folder* as many times as you like. Each folder has its own AI profile, visibility and *Auto-publish* switch.
4. **AI Profiles** — the default "Gameplay Shorts Hook" profile writes truthful, eye-catching titles. Duplicate and edit it per folder.
5. Videos are discovered, described and (for auto-publish folders) uploaded one at a time. Watch progress in **Processing Queue**; browse and edit in **Video Library**; export from **Upload History**.

### Create the Google OAuth client

1. In the Google Cloud Console create a project and enable **YouTube Data API v3**.
2. Configure the OAuth consent screen. While the app is in *Testing*, add your own Google account as a test user.
3. Create credentials → **OAuth client ID** → application type **Desktop app**. Paste the client ID (and the secret, if one is shown) into Accounts & Channels. For a desktop app the secret is not confidential and LocalTube uses PKCE.

## Using titles from a clip JSON, improved by Gemini

If your clipper writes a JSON file with a title, description and hashtags for each clip (for example `clips.json`):

- **Automatic:** any such JSON file inside a folder is read on every scan. Entries are matched to videos by file name, so the AI is not needed for those videos.
- **By hand:** use **Import metadata JSON** on a folder card in **Folders**, or at the top of the **Video Library**, to pick a JSON file from anywhere.
- **Improve with Gemini** (on by default once your key and consent are set): Gemini rewrites each title, writes a better description and adds more hashtags, using only the facts in the JSON (the clipper's caption, hook and reason are passed along as context). The folder's AI profile sets the language and tone, for example Hinglish. Only text is sent to Gemini, not video.
- **Safe by design:** uploads wait for the improved text, but if Gemini fails or returns something invalid or suspicious (a link, instruction text), the original JSON text is kept and uploads are not blocked. Every version is kept: open a video in the Library and press **Restore original** at any time. A title you edit by hand is never overwritten automatically.
- **Re-scans never undo it:** the same JSON entry is not imported twice; a changed entry replaces the improved text and is improved again.
- **Settings > AI > Test Gemini** sends one tiny request and tells you in plain words if the key, quota or model is the problem. Google retires models and gives some keys little quota, so if you see a quota error pick another model from the list.

## Limits you should know about (verify before relying on them)

These are from memory of Google's documentation and **must be re-checked** against the official pages listed in `CLAUDE.md` section 15:

- The default YouTube Data API quota is about 10,000 units per day and one upload costs about 1,600, so roughly 6 uploads per day per project until Google approves a higher quota.
- Videos uploaded by an API project that has not passed Google's compliance audit may be forced to private.
- For 20+ uploads a day you need a quota extension and the API compliance audit. Apply early; it can take weeks.
- Channels also have their own daily upload limits.

There is no local daily cap. When YouTube says a limit is reached, LocalTube pauses the remaining jobs (nothing fails, nothing is lost) and resumes by itself after the expected quota reset, or when you press *Retry*. It never tries to work around a limit.

## How it keeps your uploads safe

- **One upload at a time** by default, with exponential backoff and jitter on temporary errors, and a cap of 6 attempts.
- **Resumable uploads.** If the app or your connection dies, it continues from where YouTube says it left off.
- **No blind retry after an uncertain result.** If the connection drops right after the last byte, LocalTube asks YouTube through the saved upload session what happened. If it still cannot tell, the job stops in *Upload outcome unknown* and asks you. It never starts a second upload on its own.
- **Duplicate protection.** Files are fingerprinted with SHA-256; an identical file in another folder is not uploaded twice unless you click *Allow republish*.
- **Files still being copied are skipped** until their size and timestamp stop changing.
- **A file edited after metadata was written** marks the metadata stale and pauses the job.
- **"Uploaded" is not "Published".** Transfer completion and YouTube's own processing are tracked separately; a video counts as published only when YouTube finished processing and its privacy matches what you asked for.
- **Source videos are never modified, moved or deleted.** Removing a folder only removes it from LocalTube.
- **Secrets stay on the server**, encrypted with Windows DPAPI; the browser never receives tokens or keys, and logs redact them.

## Where things live

Everything is under `data/` in this folder (override with the `LOCALTUBE_DATA` environment variable): the SQLite database, encrypted secrets, rotating logs. Extracted frames go to a temporary folder you can change in Settings and are deleted after each video.

## Tests

```powershell
npm test            # fast server tests, fake Google / Gemini / YouTube servers
npm run test:ui     # builds the UI and runs the browser smoke test (uses the Edge that ships with Windows)
npm run test:all
```

The end-to-end test (`tests/e2e`) runs the real runtime in a separate process, kills it with SIGKILL in the middle of an upload, restarts it, and checks that each unique video is uploaded exactly once.

## Not built yet

Google Sheets export, publishing windows and minimum upload intervals, live folder monitoring (folders are rescanned on a timer instead), playlists, multiple channels, scheduled publishing, installer/auto-update. See `CLAUDE.md` for the full product spec and `docs/superpowers/` for the design and plan.
