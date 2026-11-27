# LocalTube — Design (local web app)

Date: 2026-11-19
Status: Draft for approval
Source spec: `CLAUDE.md` (the PRD). This document records the decisions made in conversation and where they differ from or narrow the PRD. Where this document is silent, the PRD applies.

## 1. Intent and why

The user has finished, edited gameplay Shorts on disk. They want to stop writing titles and descriptions and stop uploading by hand. LocalTube scans folders they choose, writes a hook-style title, description and hashtags from the actual clip content, and uploads to their YouTube channel automatically, within safe limits.

Intended for public release eventually, with 20+ uploads/day as the target volume.

## 2. Goals

1. Add any number of local folders from the UI, each with its own settings. No paths are pasted into code or config.
2. Generate title, description and hashtags from video frames (not filenames), using a hook / eye-catching style that stays truthful to the clip.
3. Auto-publish by default, with safeguards: duplicate protection and a safe stop on quota or channel-limit errors. There is no local daily cap (user decision). All eligible videos are queued in one batch.
4. Durable queue: no silent job loss, no blind retry after an uncertain upload outcome (PRD sections 7, 8).
5. Never modify, move or delete source videos.

## 3. Non-goals and anti-goals

Non-goals: everything in PRD 1.2 (editing, transcoding, captions, cloud folder ingestion, hosted multi-user backend, engagement automation, quota circumvention).

Anti-goals (a failure even if it technically works):
- Duplicate uploads of one file.
- Misleading titles that claim events not in the clip.
- Any token or API key reaching the browser or logs.
- Promising a fixed daily upload count.

## 4. Constraints and facts to verify (Phase 0)

- Public release at 20+/day needs a YouTube API quota extension and an API compliance audit. As recalled (to be verified against official docs): default quota ~10,000 units/day, `videos.insert` ~1,600 units, so ~6 uploads/day by default; uploads from unaudited API projects may be locked to private. File the extension and audit application early, in parallel with development.
- A Claude/ChatGPT/Gemini consumer subscription does not include an API key. The app uses a user-supplied provider API key, billed separately.
- A browser cannot reveal real folder paths, so the local server owns folder selection.

## 5. Approaches considered

- **A. Single local server (chosen).** One Node process serves the React UI and the API on localhost. SQLite holds the queue. Scanner, AI and upload loops run in-process. FFmpeg runs as a child process. Simplest to build and package. A crash stops everything, but state is in SQLite and recovers on restart.
- **B. Server plus separate worker process.** Better crash isolation. More code and inter-process coordination through the database. Deferred. Keep queue and state-machine modules clean so this split is possible later.
- **C. Hosted backend plus local agent.** Rejected: cloud cost and accounts, breaks the local-first goal.
- Also rejected: pure in-browser site (Chromium only, permission prompts each session, no background queue, no native FFmpeg) and hosted SaaS that receives user videos.

## 6. Decisions the user made

- Local web app, not Electron. Form: single local server (A).
- Content: finished gameplay Shorts. No editing features.
- Title style: hook, eye-catching.
- Publishing: auto-publish with safeguards (duplicate protection, stop on quota errors). Daily cap removed entirely: no cap setting, no "remaining allowance" on the dashboard, and PRD QUE-08's daily cap is dropped. Everything is queued in one shot.
- AI provider: Google Gemini for titles, descriptions and hashtags.
- Folders: multiple, added dynamically in the UI.
- Audience: public release. Volume target: 20+/day.

## 7. Decisions I made (user may override)

- Folder add: the server opens the native Windows folder dialog (PowerShell/.NET) and stores the chosen path in SQLite. Fallback is an in-UI folder browser served by the API. Manual path typing is allowed in the UI only as a last resort.
- Stack follows the PRD: Node + TypeScript, React + Vite, Tailwind, SQLite (better-sqlite3 + a typed layer such as Drizzle), Zod validation, Vitest + Playwright, structured rotating logs.
- Server binds to 127.0.0.1 only. A random per-session token protects the API. The Google refresh token and AI key stay server-side, encrypted with Windows DPAPI or an established credential-store library, never sent to the browser.
- AI provider: Gemini (user's choice) via an adapter interface so others can be added later. The user supplies a Gemini API key (Google AI Studio). Exact model, free-tier limits and pricing to be verified in Phase 0. Cloud analysis sends sampled frames only, with an explicit consent toggle and an option to disable it.
- With no cap, a large batch queued at once will hit YouTube quota or channel limits. The app handles this by pausing affected jobs with a clear message and resuming when the limit resets or the user retries. Uploads stay one at a time by default. Jobs waiting on quota are not failures and are not lost.
- Shorts check: FFprobe reads duration and dimensions. Warn if a file is not vertical/square or is longer than the current Shorts limit (verify the limit in Phase 0). Does not block upload.
- Truthful-hook guardrail in the system prompt: hooks must come from visible content, the game is named only when confident, otherwise the title omits it. Filenames and on-screen text are untrusted data.
- Default hashtags: fixed `#Shorts` plus up to a few generated, per profile.
- Default visibility: Public (PRD default), per folder.
- Auto-publish default is on for new folders per the user's choice.
- Build order, as separate plans in sequence: (1) foundation: server, UI shell, SQLite, folders, scan; (2) FFprobe, fingerprints, duplicates, library; (3) AI profiles and generation; (4) YouTube OAuth and a single resumable upload; (5) queue, retries, recovery, quota handling; (6) publishing windows, monitoring, history, CSV (no daily cap); (7) packaging, OAuth verification. The first plan covers (1) only.

## 8. Architecture (approach A)

```
Browser UI (React)  <--HTTP/WebSocket-->  Local server (Node, 127.0.0.1)
                                           |- API + auth token
                                           |- Scanner loop  --> FFprobe
                                           |- AI loop       --> FFmpeg frames --> AI provider
                                           |- Upload loop   --> YouTube Data API (resumable)
                                           |- Monitor loop  --> YouTube processing status
                                           '- SQLite (jobs, videos, metadata, history, audit)
```

Data model, state machine, retry policy, graceful shutdown, disk/memory limits: as PRD sections 6, 7 and 8. Separate status fields for discovery, metadata, approval, upload and YouTube processing. The `UPLOAD_OUTCOME_UNKNOWN` state stops for user action when reconciliation fails.

Because auto-publish is the default, the "approval" state is set automatically only after metadata validation passes. Low-confidence or invalid metadata still falls to needs-review instead of publishing.

## 9. Left to the builder

UI layout and styling, exact SQL schema and indexes, the Drizzle vs plain typed SQL choice, library choices for the native folder dialog and credential storage, the upload-reconciliation mechanics, and test fixtures. Each must satisfy the PRD acceptance criteria (section 10) and test scenarios (10.1).

## 10. Open items (not blocking the first plan)

- Which Gemini model to use (verify availability, vision support and limits in Phase 0).
- Exact current YouTube quota, upload limits and Shorts duration limit (Phase 0 verification).
- Packaging for non-technical public users (launcher/installer for a local Node app).
