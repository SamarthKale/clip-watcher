# LocalTube --- Product Requirements & Technical Design

**Document type:** Product Requirements Document (PRD) + Technical
Specification\
**Platform:** Windows desktop (MVP)\
**Status:** Proposed implementation baseline\
**Version:** 1.0\
**Date:** 18 November 2026

------------------------------------------------------------------------

## 1. Executive summary

LocalTube is a local-first Windows desktop application for preparing and
publishing videos to YouTube in bulk.

The user selects multiple folders on their computer. LocalTube scans
only those selected folders for MP4 files, optionally including nested
folders. Each video is analyzed to understand its content, then AI
generates a YouTube title, description, and hashtags using the AI
profile assigned to that video's source folder.

The user can review and edit generated metadata or enable automatic
publishing. Approved videos are uploaded to a selected YouTube channel
using the YouTube Data API. The application maintains a durable local
record of every video, processing stage, upload attempt, YouTube video
ID, and final URL.

**Core principle:** LocalTube must be reliable before it is fast. It
must recover safely from application crashes, interrupted uploads,
network failures, API errors, and uncertain upload outcomes without
silently losing work or creating duplicate uploads.

### 1.1 Product goals

1.  Make it easy to manage videos from multiple local folders.
2.  Generate relevant titles and descriptions based on the actual video
    content, not just filenames.
3.  Apply different AI instructions and publishing defaults to different
    folders.
4.  Publish videos to YouTube in a controlled bulk workflow.
5.  Preserve queue state and recover after restarts.
6.  Make upload limits, failures, and publishing status visible.
7.  Avoid unnecessary cloud infrastructure and keep source video files
    on the user's computer.

### 1.2 Non-goals for the MVP

-   Google Drive or other cloud-storage folder ingestion.
-   Subtitle, transcript, or caption-file generation.
-   Video editing, clipping, transcoding, or thumbnail generation.
-   A hosted multi-user SaaS backend.
-   Automated engagement, views, likes, comments, or other artificial
    activity.
-   Circumventing YouTube quotas, channel limits, or platform
    enforcement.
-   Guaranteed upload throughput or guaranteed daily publishing volume.

------------------------------------------------------------------------

## 2. Target user workflow

1.  Install and open LocalTube on Windows.
2.  Connect a Google account and authorize access to the intended
    YouTube channel.
3.  Select one or more local folders.
4.  Configure each folder with an AI profile and publishing defaults.
5.  Scan the folders for eligible MP4 files.
6.  Review detected videos and their status.
7.  Generate titles, descriptions, and hashtags.
8.  Review/edit metadata, or enable an explicitly configured
    auto-publish mode.
9.  Add eligible videos to the upload queue.
10. Monitor uploads, retries, processing status, and published URLs.
11. Export upload history to CSV or Google Sheets (Google Sheets
    integration is a later-phase feature).

------------------------------------------------------------------------

## 3. Scope and requirements

Priority definitions: - **P0 --- Must have:** Required for a safe MVP. -
**P1 --- Should have:** Important for a complete first release. - **P2
--- Later:** Useful enhancement, not required for initial release.

### 3.1 Local folder management

  -----------------------------------------------------------------------
  ID                      Priority                Requirement
  ----------------------- ----------------------- -----------------------
  FOLD-01                 P0                      User can select
                                                  multiple local folders
                                                  in one session.

  FOLD-02                 P0                      User can add and remove
                                                  folders independently.

  FOLD-03                 P0                      Selected folder paths
                                                  persist after
                                                  application restart.

  FOLD-04                 P0                      Scan only folders
                                                  explicitly added by the
                                                  user.

  FOLD-05                 P0                      Detect `.mp4` files
                                                  case-insensitively.

  FOLD-06                 P0                      Support configurable
                                                  recursive scanning of
                                                  subfolders.

  FOLD-07                 P0                      Ignore temporary,
                                                  hidden, inaccessible,
                                                  and incomplete files by
                                                  default.

  FOLD-08                 P1                      Monitor selected
                                                  folders for newly added
                                                  or changed files.

  FOLD-09                 P1                      Allow per-folder
                                                  include/exclude rules.

  FOLD-10                 P1                      Provide a rescan action
                                                  and show the last scan
                                                  time.

  FOLD-11                 P1                      Handle disconnected
                                                  drives and unavailable
                                                  paths without deleting
                                                  records.

  FOLD-12                 P2                      Support removable
                                                  drives and
                                                  network-mounted folders
                                                  with clear availability
                                                  indicators.
  -----------------------------------------------------------------------

**Folder behavior** - A folder is a source, not a command to upload
everything immediately. - Scanning discovers files; it must not
automatically publish them unless the user has enabled auto-publishing
for that folder. - Folder monitoring must debounce filesystem events and
verify that a file is stable before processing it. - A file should be
considered stable only after its size and modification time remain
unchanged for a configurable period and the file can be opened. - If a
file changes after metadata generation but before upload, mark the
previous metadata as stale and require regeneration or explicit
confirmation.

### 3.2 Video discovery and duplicate detection

  -----------------------------------------------------------------------
  ID                      Priority                Requirement
  ----------------------- ----------------------- -----------------------
  VID-01                  P0                      Record file path,
                                                  filename, size,
                                                  modification time, and
                                                  detected media
                                                  properties.

  VID-02                  P0                      Use FFprobe to inspect
                                                  duration, dimensions,
                                                  frame rate, codecs, and
                                                  audio streams.

  VID-03                  P0                      Identify duplicate
                                                  content across selected
                                                  folders.

  VID-04                  P0                      Maintain a persistent
                                                  video record in SQLite.

  VID-05                  P0                      Never treat filename
                                                  alone as proof of file
                                                  identity.

  VID-06                  P1                      Use a content
                                                  fingerprint strategy
                                                  that balances accuracy
                                                  and scan cost.

  VID-07                  P1                      Detect changed files
                                                  and invalidate stale
                                                  metadata.

  VID-08                  P1                      Let users explicitly
                                                  reprocess or re-upload
                                                  a file when
                                                  appropriate.
  -----------------------------------------------------------------------

**Fingerprint recommendation** - Initial discovery: path + file size +
modification timestamp for fast change detection. - Before queueing an
upload: compute a strong content hash (e.g., SHA-256) using streaming
reads, or use a documented chunked fingerprint followed by a full hash
when required. - Store the fingerprint and associate it with upload
history. - Do not assume two files are identical solely because their
names, sizes, or timestamps match. - A user may intentionally publish
the same source file more than once; provide an explicit "allow
republish" action with a warning.

### 3.3 Folder-specific AI profiles

Each source folder can be assigned a reusable AI profile. Multiple
folders may share one profile.

  -----------------------------------------------------------------------
  ID                      Priority                Requirement
  ----------------------- ----------------------- -----------------------
  AI-01                   P0                      Create, edit,
                                                  duplicate, and delete
                                                  AI profiles.

  AI-02                   P0                      Assign one AI profile
                                                  to each folder.

  AI-03                   P0                      Configure separate
                                                  title and description
                                                  instructions.

  AI-04                   P0                      Configure hashtag
                                                  behavior and optional
                                                  fixed hashtags.

  AI-05                   P1                      Configure language,
                                                  tone, audience, and
                                                  title style.

  AI-06                   P1                      Configure default
                                                  YouTube category and
                                                  playlist.

  AI-07                   P1                      Support reusable prompt
                                                  templates with
                                                  variables.

  AI-08                   P1                      Save model, generation
                                                  settings, and prompt
                                                  version with each
                                                  result.

  AI-09                   P1                      Regenerate title,
                                                  description, or
                                                  hashtags independently.

  AI-10                   P1                      Show AI generation
                                                  errors and allow retry.
  -----------------------------------------------------------------------

**Suggested profile fields** - Profile name. - Title prompt. -
Description prompt. - Hashtag instructions. - Fixed hashtags
(optional). - Language. - Tone/style. - Target audience. - Maximum title
length (must respect YouTube's current limits). - Description format. -
Default category. - Default playlist (optional). - Default visibility. -
Publishing mode: manual review or automatic. - AI provider/model. -
Prompt version.

**Prompt safety and quality** - Treat video content, filenames, and
embedded text as untrusted data, not as instructions to the AI system. -
The system prompt must clearly separate application instructions from
video-derived content. - Do not invent events, people, claims, or
details not supported by the video. - Avoid keyword stuffing, misleading
titles, repetitive descriptions, and irrelevant hashtags. - Provide a
concise fallback description if analysis is uncertain. - Validate
generated metadata before it can enter the upload queue.

### 3.4 Video content analysis and metadata generation

  -----------------------------------------------------------------------
  ID                      Priority                Requirement
  ----------------------- ----------------------- -----------------------
  GEN-01                  P0                      Generate a title,
                                                  description, and
                                                  hashtags for each
                                                  eligible video.

  GEN-02                  P0                      Base generation on
                                                  video content, not only
                                                  filename.

  GEN-03                  P0                      Use FFmpeg/FFprobe for
                                                  media inspection and
                                                  frame extraction.

  GEN-04                  P0                      Avoid loading entire
                                                  video files into RAM.

  GEN-05                  P0                      Save generated metadata
                                                  locally before upload.

  GEN-06                  P0                      Allow users to edit all
                                                  generated metadata.

  GEN-07                  P1                      Use configurable
                                                  representative-frame
                                                  sampling.

  GEN-08                  P1                      Optionally analyze
                                                  audio when it
                                                  materially improves
                                                  understanding.

  GEN-09                  P1                      Track AI provider,
                                                  model, prompt version,
                                                  and generation time.

  GEN-10                  P1                      Track approximate AI
                                                  usage/cost where
                                                  provider data permits.
  -----------------------------------------------------------------------

**Recommended analysis pipeline** 1. Confirm the file is stable and
readable. 2. Run FFprobe to extract technical metadata. 3. Extract a
small set of representative frames using FFmpeg. 4. Avoid blindly
sampling only the first few seconds; distribute samples across the
duration and include scene changes where practical. 5. Send selected
frames to a vision-capable model. 6. Optionally extract audio or short
audio segments for analysis when speech or sound is relevant. 7.
Generate structured metadata using the folder's assigned AI profile. 8.
Validate and save the result. 9. Mark metadata stale if the underlying
file or profile prompt changes.

**Efficiency principles** - Do not upload every full video to an AI
service by default. - Use a staged approach: inexpensive technical
inspection first, then representative-frame analysis, then optional
deeper analysis only when needed. - Cache analysis results by content
fingerprint and prompt/model version. - Allow users to regenerate only
the title, description, or hashtags without repeating the entire
analysis. - Make clear in the UI that frames/audio sent to an external
AI provider leave the local computer. - Offer provider selection and an
option to disable cloud AI analysis.

**Metadata output schema**

``` json
{
  "title": "Example YouTube title",
  "description": "Example description...",
  "hashtags": ["#Example", "#Shorts"],
  "categoryId": "optional-category-id",
  "language": "optional-language-code",
  "confidence": "high|medium|low",
  "needsReview": true
}
```

The actual schema should be validated in application code. The AI
response must never be inserted directly into an upload request without
validation.

### 3.5 Review and approval

  -----------------------------------------------------------------------
  ID                      Priority                Requirement
  ----------------------- ----------------------- -----------------------
  REV-01                  P0                      Show detected videos in
                                                  a sortable, filterable
                                                  table.

  REV-02                  P0                      Show thumbnail/preview,
                                                  filename, folder,
                                                  duration, and
                                                  processing status.

  REV-03                  P0                      Show generated title,
                                                  description, and
                                                  hashtags.

  REV-04                  P0                      Allow inline editing
                                                  before upload.

  REV-05                  P0                      Support selecting
                                                  multiple videos for
                                                  queueing.

  REV-06                  P0                      Distinguish "metadata
                                                  ready" from "approved
                                                  to upload."

  REV-07                  P1                      Bulk approve or reject
                                                  selected videos.

  REV-08                  P1                      Show warnings for
                                                  low-confidence or
                                                  incomplete metadata.

  REV-09                  P1                      Provide a preview of
                                                  how the title and
                                                  description will
                                                  appear.
  -----------------------------------------------------------------------

**Approval rules** - Manual review is the default. - Auto-publishing
must be an explicit opt-in setting, separately configurable per
folder. - Auto-publishing must still respect daily limits, validation,
duplicate protection, and user-defined scheduling. - Changing a folder's
publishing mode must not silently change already queued jobs.

### 3.6 YouTube account and channel management

  -----------------------------------------------------------------------
  ID                      Priority                Requirement
  ----------------------- ----------------------- -----------------------
  YT-01                   P0                      Authenticate using
                                                  Google's supported
                                                  OAuth flow for desktop
                                                  applications.

  YT-02                   P0                      Use the minimum
                                                  required YouTube
                                                  scopes.

  YT-03                   P0                      Allow the user to
                                                  select/confirm the
                                                  intended YouTube
                                                  channel.

  YT-04                   P0                      Store tokens securely
                                                  using Windows-protected
                                                  credential storage.

  YT-05                   P0                      Support token refresh
                                                  and reauthorization
                                                  when needed.

  YT-06                   P0                      Provide disconnect and
                                                  revoke-access guidance.

  YT-07                   P1                      Support multiple
                                                  authorized channels.

  YT-08                   P1                      Display channel
                                                  identity before bulk
                                                  publishing.
  -----------------------------------------------------------------------

**Security requirements** - Use an OAuth flow appropriate for installed
desktop applications, including PKCE where supported by the selected
Google library/flow. - Do not embed a confidential client secret and
assume it is secure in a distributed desktop binary. - Never store
Google account passwords. - Never expose refresh tokens or AI API keys
to the renderer process. - Encrypt credentials using Windows DPAPI or an
established secure credential-store library. - Redact tokens and
sensitive headers from logs. - Request only scopes necessary for the
implemented features. - Plan for Google's OAuth verification and YouTube
API compliance requirements before public distribution.

### 3.7 YouTube publishing

  -----------------------------------------------------------------------
  ID                      Priority                Requirement
  ----------------------- ----------------------- -----------------------
  UP-01                   P0                      Upload video files
                                                  using YouTube Data API
                                                  `videos.insert`.

  UP-02                   P0                      Use resumable uploads
                                                  for large files and
                                                  recovery.

  UP-03                   P0                      Upload title,
                                                  description, category,
                                                  and privacy status.

  UP-04                   P0                      Support Public,
                                                  Unlisted, and Private
                                                  visibility.

  UP-05                   P0                      Persist upload state
                                                  and session information
                                                  where supported.

  UP-06                   P0                      Track the returned
                                                  YouTube video ID and
                                                  URL.

  UP-07                   P0                      Distinguish transfer
                                                  completion from YouTube
                                                  processing completion.

  UP-08                   P0                      Retry transient
                                                  failures with
                                                  exponential backoff and
                                                  jitter.

  UP-09                   P0                      Do not blindly retry an
                                                  upload with an
                                                  uncertain outcome.

  UP-10                   P0                      Pause queueing when API
                                                  quota or channel limits
                                                  are reached.

  UP-11                   P1                      Support playlist
                                                  assignment where
                                                  supported by the API.

  UP-12                   P1                      Support scheduled
                                                  publishing where
                                                  supported and
                                                  validated.

  UP-13                   P1                      Configure subscriber
                                                  notification behavior.

  UP-14                   P1                      Allow pause, resume,
                                                  and cancel actions with
                                                  clear semantics.
  -----------------------------------------------------------------------

**Important publishing distinction** - A successful `videos.insert`
transfer does not mean the video is fully processed or publicly
watchable. - Store the returned video ID immediately after a successful
API response. - Track YouTube processing status separately using the
supported API fields/endpoints. - A video may be uploaded but still
processing, rejected, or otherwise not ready for normal playback. - Do
not label a video "Published" until the application's defined publishing
checks pass. Use intermediate states such as "Upload complete" and
"Processing on YouTube."

**Uncertain upload outcomes** A connection may fail after YouTube has
accepted the upload but before LocalTube receives or stores the
response. In this case: 1. Mark the job `UPLOAD_OUTCOME_UNKNOWN`. 2.
Preserve the last known resumable-session state and request metadata. 3.
Attempt supported reconciliation before starting a new upload. 4. If the
application cannot establish whether the upload succeeded, stop and
request user intervention rather than risk a duplicate. 5. Record the
resolution in the audit history.

Do not assume the API offers a universal idempotency key for video
insertion.

### 3.8 Queue, scheduling, and rate control

  -----------------------------------------------------------------------
  ID                      Priority                Requirement
  ----------------------- ----------------------- -----------------------
  QUE-01                  P0                      Use a persistent queue
                                                  stored in SQLite.

  QUE-02                  P0                      Separate discovery, AI
                                                  analysis, and upload
                                                  jobs.

  QUE-03                  P0                      Persist job state
                                                  before and after
                                                  important operations.

  QUE-04                  P0                      Default to one active
                                                  upload at a time.

  QUE-05                  P0                      Make concurrency
                                                  configurable within
                                                  safe limits.

  QUE-06                  P0                      Support pause/resume
                                                  and graceful shutdown.

  QUE-07                  P0                      Recover eligible jobs
                                                  after application
                                                  restart.

  QUE-08                  P1                      Configure daily upload
                                                  caps and minimum
                                                  intervals.

  QUE-09                  P1                      Configure allowed
                                                  publishing windows.

  QUE-10                  P1                      Support per-channel
                                                  scheduling settings.

  QUE-11                  P1                      Show why a job is
                                                  waiting or blocked.
  -----------------------------------------------------------------------

**Queue separation** - Discovery queue: identifies and validates local
files. - AI queue: generates metadata. - Upload queue: publishes
approved videos. - Monitoring queue: checks YouTube processing status
and reconciles uncertain jobs.

AI generation and upload should be independent. For example, while one
video is uploading, the application may prepare metadata for the next
videos, subject to configured AI concurrency and system resources.

**Suggested initial concurrency** - Upload workers: 1. - AI workers: 2,
configurable. - Folder scanning: incremental and low priority. - YouTube
status polling: conservative, batched where supported, and rate-limited.

These are starting defaults, not universal performance guarantees. The
user should be able to lower concurrency on slower systems or metered
connections.

### 3.9 Quotas and daily limits

The application must not hard-code a promise that every channel can
upload a fixed number of videos per day.

There are distinct limits: 1. YouTube Data API project quota and
endpoint-specific quota costs. 2. YouTube channel-level daily upload
limits and feature eligibility. 3. Temporary API errors,
abuse-prevention controls, and other platform restrictions.

Requirements: - Show API quota information only when it can be obtained
reliably. - Let users configure a conservative local daily cap. - Detect
quota-related and channel-limit errors. - Stop affected uploads safely
when a limit is reached. - Display the exact error category and next
action. - Resume only when the limit is known to have reset or the user
retries. - Do not rotate projects, accounts, or credentials to bypass
limits. - Keep quota configuration updateable because Google's quota
policies can change.

**Important:** API quota reset timing and channel upload-limit behavior
must be verified against current official documentation during
implementation. Do not present a local estimate as Google's guaranteed
remaining channel allowance.

### 3.10 Monitoring, reporting, and export

  -----------------------------------------------------------------------
  ID                      Priority                Requirement
  ----------------------- ----------------------- -----------------------
  REP-01                  P0                      Show counts for
                                                  detected, ready,
                                                  queued, uploading,
                                                  uploaded, processing,
                                                  published, failed, and
                                                  skipped videos.

  REP-02                  P0                      Show per-video progress
                                                  and clear error
                                                  messages.

  REP-03                  P0                      Store YouTube video ID
                                                  and URL.

  REP-04                  P0                      Provide searchable
                                                  upload history.

  REP-05                  P1                      Export upload history
                                                  to CSV.

  REP-06                  P1                      Export selected records
                                                  to Google Sheets.

  REP-07                  P1                      Show AI usage/cost
                                                  estimates where
                                                  available.

  REP-08                  P1                      Provide diagnostic logs
                                                  with secrets redacted.
  -----------------------------------------------------------------------

Suggested history fields: - Source folder. - Original file path and
filename. - File fingerprint. - File size and duration. - AI profile and
prompt version. - Generated title and description. - Channel
identifier. - Visibility. - Upload start/end times. - Upload result. -
YouTube video ID and URL. - YouTube processing status. - Error category
and last error. - Retry count.

------------------------------------------------------------------------

## 4. User interface requirements

### 4.1 Main navigation

1.  Dashboard
2.  Folders
3.  AI Profiles
4.  Video Library
5.  Processing Queue
6.  Upload History
7.  Accounts & Channels
8.  Settings

### 4.2 Dashboard

Show: - Total detected videos. - Metadata ready. - Awaiting approval. -
Queued for upload. - Currently uploading. - Upload complete /
processing. - Published. - Failed or needs attention. - Current daily
local cap and remaining local allowance. - Connected YouTube channel. -
Recent activity.

Do not show sample or fabricated metrics in the real application. Empty
states should clearly say that no data is available yet.

### 4.3 Folder manager

Each folder card/row should show: - Folder name and path. - Availability
status. - Recursive scanning enabled/disabled. - Monitoring
enabled/disabled. - Assigned AI profile. - Publishing mode. - Default
visibility. - Playlist. - Number of discovered videos. - Last scan time.

Actions: - Add folders. - Remove folder from LocalTube (never delete
source files). - Scan now. - Open folder in File Explorer. - Edit folder
settings. - Pause monitoring.

### 4.4 Video library

Suggested columns: - Selection checkbox. - Thumbnail. - Filename. -
Source folder. - Duration. - File size. - AI status. - Approval
status. - Upload status. - YouTube URL.

Filters: - Folder. - AI profile. - Metadata status. - Approval status. -
Upload status. - Date discovered. - Errors only.

Bulk actions: - Generate metadata. - Regenerate selected metadata. -
Approve. - Reject/skip. - Add to upload queue. - Change publishing
settings, with confirmation.

### 4.5 Metadata editor

Provide: - Video preview. - Generated title field. - Description
editor. - Hashtag editor. - AI profile indicator. - Regenerate title. -
Regenerate description. - Regenerate hashtags. - Save changes. - Approve
for upload.

### 4.6 Upload history

Show: - File and source folder. - YouTube channel. - Title. - Upload
date. - Current YouTube status. - Visibility. - YouTube link. - Error
details, if any.

------------------------------------------------------------------------

## 5. Recommended technical architecture

### 5.1 Architecture principles

-   Local-first: source videos and operational database remain on the
    user's computer.
-   No mandatory hosted backend for the single-user MVP.
-   Keep renderer and privileged desktop processes isolated.
-   Use a persistent SQLite-backed job system.
-   Use streaming file I/O; never load large video files fully into
    memory.
-   Make every long-running operation cancellable or recoverable where
    practical.
-   Keep AI and YouTube integrations behind provider/service interfaces.
-   Keep secrets out of UI state, logs, and renderer-accessible storage.

### 5.2 Technology choices

  -----------------------------------------------------------------------
  Layer                   Recommended technology  Reason
  ----------------------- ----------------------- -----------------------
  Desktop shell           Electron                Mature Windows desktop
                                                  ecosystem and Node
                                                  integration through a
                                                  controlled main process

  UI                      React + TypeScript      Maintainable dashboard
                                                  and reusable components

  Styling                 Tailwind CSS            Consistent UI
                                                  development

  Runtime                 Node.js + TypeScript    Local filesystem, API
                                                  integrations,
                                                  background tasks

  Media inspection        FFmpeg + FFprobe        Reliable media probing
                                                  and frame extraction

  Folder monitoring       Chokidar or native      Detect file changes,
                          filesystem watcher      with periodic
                                                  reconciliation

  Database                SQLite                  Local durable storage
                                                  and sufficient scale
                                                  for a single-user MVP

  Database access         Drizzle ORM or a typed  Migrations and typed
                          SQL layer               data access

  Validation              Zod                     Validate settings and
                                                  AI-generated metadata

  Logging                 Structured rotating     Diagnostics without
                          logs                    unbounded log growth

  Testing                 Vitest +                Unit, integration, and
                          Playwright/Electron     UI tests
                          test harness            

  Packaging               Electron Builder or     Windows installer and
                          equivalent              updates
  -----------------------------------------------------------------------

**Architecture caution:** Electron is a reasonable choice for the
Windows-first MVP. Keep the filesystem and credential operations in the
main process or a dedicated worker process. Do not enable unrestricted
Node integration in the renderer. Use a narrow, validated preload API
and a strict Content Security Policy.

### 5.3 Logical components

-   **Renderer:** React dashboard; no direct access to secrets or
    unrestricted filesystem.
-   **Preload bridge:** Explicit, typed methods exposed to the UI.
-   **Main process:** Window lifecycle, permissions, folder dialogs,
    secure credential access, and application coordination.
-   **Scanner worker:** Incremental file discovery and FFprobe
    inspection.
-   **Media worker:** FFmpeg frame/audio extraction.
-   **AI service:** Provider abstraction, prompt construction, metadata
    validation.
-   **Upload service:** OAuth, resumable upload, status polling, error
    classification.
-   **Queue manager:** Persistent state transitions, scheduling,
    retries, and recovery.
-   **Database layer:** SQLite schema, migrations, and transactions.
-   **Monitoring service:** Filesystem reconciliation and YouTube
    processing checks.

------------------------------------------------------------------------

## 6. Data model

The following is a logical model. Final SQL types, indexes, and
migrations should be decided during implementation.

### 6.1 Core entities

**Folder** - `id` - `path` - `display_name` - `recursive_scan` -
`monitor_enabled` - `ai_profile_id` - `publishing_mode` -
`default_visibility` - `default_category_id` - `default_playlist_id` -
`is_enabled` - `last_scan_at` - `created_at` - `updated_at`

**AIProfile** - `id` - `name` - `provider` - `model` - `title_prompt` -
`description_prompt` - `hashtag_prompt` - `fixed_hashtags` -
`language` - `tone` - `target_audience` - `generation_settings_json` -
`prompt_version` - `created_at` - `updated_at`

**Video** - `id` - `folder_id` - `file_path` - `filename` -
`file_size_bytes` - `modified_at` - `content_hash` -
`duration_seconds` - `width` - `height` - `frame_rate` - `video_codec` -
`audio_codec` - `discovery_status` - `metadata_status` -
`approval_status` - `upload_status` - `created_at` - `updated_at`

**VideoMetadata** - `id` - `video_id` - `ai_profile_id` -
`prompt_version` - `provider` - `model` - `title` - `description` -
`hashtags_json` - `category_id` - `language` - `confidence` -
`needs_review` - `is_current` - `created_at`

**YouTubeAccount** - `id` - `google_account_label` - `channel_id` -
`channel_title` - `encrypted_credentials_reference` - `connected_at` -
`last_validated_at` - `is_enabled`

**UploadJob** - `id` - `video_id` - `youtube_account_id` -
`metadata_id` - `visibility` - `scheduled_at` - `status` -
`attempt_count` - `last_error_code` - `last_error_message` -
`resumable_session_reference` - `youtube_video_id` -
`upload_started_at` - `upload_completed_at` - `created_at` -
`updated_at`

**ActivityLog** - `id` - `entity_type` - `entity_id` - `event_type` -
`message` - `details_json` - `created_at`

### 6.2 Database rules

-   Use transactions for state transitions and related records.
-   Add indexes for queue status, folder ID, content hash, and YouTube
    video ID.
-   Enforce appropriate uniqueness constraints for active jobs.
-   Never delete upload history when a source folder is removed.
-   Removing a folder must not delete original video files.
-   Store credential material outside ordinary application tables; keep
    only a secure reference in SQLite.
-   Use database migrations and test migration recovery.
-   Back up the SQLite database before destructive migrations.

------------------------------------------------------------------------

## 7. Video lifecycle and state machine

A video must have separate discovery, metadata, approval, upload, and
YouTube-processing states. Avoid one overloaded status field.

### 7.1 High-level lifecycle

``` mermaid
flowchart TD
    A[File discovered] --> B[Check file stability]
    B --> C[Validate MP4 and probe]
    C --> D{Duplicate?}
    D -->|Yes| E[Mark duplicate or skipped]
    D -->|No| F[Analyze representative frames]
    F --> G[Generate title and description]
    G --> H[Validate metadata]
    H --> I{Needs review?}
    I -->|Yes| J[Awaiting user approval]
    I -->|No, auto mode enabled| K[Eligible for queue]
    J -->|Approved| K
    J -->|Rejected| L[Skipped]
    K --> M[Upload queue]
    M --> N[Resumable upload]
    N --> O{Upload outcome}
    O -->|Success| P[Store YouTube video ID]
    O -->|Temporary failure| Q[Retry with backoff]
    O -->|Uncertain| R[Reconcile before retry]
    O -->|Permanent failure| S[Needs attention]
    Q --> N
    R --> N
    P --> T[Check YouTube processing]
    T --> U[Processing / Published / Rejected]
```

### 7.2 Suggested statuses

Discovery: - `DISCOVERED` - `WAITING_FOR_STABLE_FILE` - `VALIDATING` -
`VALID` - `INVALID` - `UNAVAILABLE` - `DUPLICATE` - `SKIPPED`

Metadata: - `NOT_STARTED` - `ANALYZING` - `GENERATING` - `READY` -
`STALE` - `FAILED`

Approval: - `NOT_REQUIRED` - `PENDING` - `APPROVED` - `REJECTED`

Upload: - `NOT_QUEUED` - `QUEUED` - `UPLOADING` - `UPLOAD_PAUSED` -
`UPLOAD_COMPLETE` - `UPLOAD_OUTCOME_UNKNOWN` - `RETRY_WAIT` -
`BLOCKED_BY_QUOTA` - `BLOCKED_BY_CHANNEL_LIMIT` - `FAILED_PERMANENTLY` -
`CANCELLED`

YouTube processing: - `NOT_CHECKED` - `PROCESSING` - `READY` -
`REJECTED` - `STATUS_UNKNOWN`

------------------------------------------------------------------------

## 8. Reliability and recovery requirements

This section is a release blocker, not optional polish.

### 8.1 Crash recovery

On startup: 1. Open and validate the SQLite database. 2. Load all
non-terminal jobs. 3. Check whether source files still exist and match
their stored fingerprints. 4. Reconcile jobs that were uploading when
the app closed. 5. Resume safe jobs. 6. Mark uncertain jobs for
reconciliation or user attention. 7. Rebuild queue views from persisted
state, not in-memory assumptions.

### 8.2 Retry policy

-   Retry only transient failures.
-   Use exponential backoff with jitter.
-   Respect `Retry-After` when supplied.
-   Do not retry invalid metadata, permission errors, unsupported files,
    or permanent policy errors automatically.
-   Limit retry attempts and show a manual retry action.
-   Persist retry count, next retry time, and last error.
-   Do not retry uncertain video insertions as if they were ordinary
    network failures.

### 8.3 Graceful shutdown

When the user exits: - Stop discovering new work. - Finish or safely
pause active tasks. - Persist upload session and queue state. - Flush
database writes. - Close file handles and worker processes. - Do not
mark incomplete jobs as successful.

### 8.4 Disk and memory protection

-   Check available disk space for temporary extracted frames/audio and
    database growth.
-   Use bounded temporary directories and clean up only
    application-owned temporary files.
-   Never delete or modify source video files.
-   Stream file reads and uploads.
-   Limit the number and size of extracted frames.
-   Avoid retaining full-resolution frame sets longer than needed.
-   Provide a setting for the temporary processing directory.

------------------------------------------------------------------------

## 9. Security, privacy, and compliance

1.  Source videos remain on local storage unless uploaded to YouTube or
    selected assets are sent to the configured AI provider.
2.  Clearly disclose which frames/audio are sent to an external AI
    provider.
3.  Never send videos or frames to an AI provider without the user's
    configured consent.
4.  Use secure OAuth and least-privilege scopes.
5.  Protect refresh tokens and API keys using OS credential storage.
6.  Redact credentials from logs and crash reports.
7.  Use a restrictive Electron security model.
8.  Validate all renderer-to-main IPC inputs.
9.  Treat filenames, video text, audio, and model responses as untrusted
    input.
10. Do not bypass YouTube API quotas, channel restrictions, or
    enforcement.
11. Do not promise that a channel can publish a fixed daily number.
12. Before public release, review current YouTube API Services Terms,
    Developer Policies, quota requirements, OAuth verification, and
    applicable privacy disclosures.

------------------------------------------------------------------------

## 10. Performance and acceptance criteria

These are initial engineering targets to validate on the target Windows
hardware, not guarantees for every computer or network.

  -----------------------------------------------------------------------
  Area                                Acceptance criterion
  ----------------------------------- -----------------------------------
  UI responsiveness                   Long-running scans, AI calls, and
                                      uploads do not freeze the
                                      interface.

  Folder scanning                     Repeated scans are incremental and
                                      do not repeatedly reprocess
                                      unchanged files.

  File access                         Large files are streamed; memory
                                      use does not scale with total video
                                      size.

  Queue persistence                   Closing and reopening the app
                                      preserves all non-terminal jobs.

  Duplicate safety                    Same file discovered in multiple
                                      scans is not automatically queued
                                      twice.

  Metadata                            User can edit and save generated
                                      title, description, and hashtags.

  Prompt isolation                    A folder uses its assigned AI
                                      profile and recorded prompt
                                      version.

  Upload recovery                     A resumable upload can continue
                                      when the API session remains valid;
                                      otherwise it enters a safe recovery
                                      state.

  Uncertain outcome                   Application never blindly creates a
                                      second upload after an ambiguous
                                      result.

  Quota handling                      Quota/channel-limit errors pause
                                      affected jobs and show a clear
                                      explanation.

  Status accuracy                     Transfer completion and YouTube
                                      processing completion are separate
                                      states.

  Security                            Tokens and API keys are not exposed
                                      to renderer code or logs.

  Source preservation                 Application never edits, moves, or
                                      deletes source videos.

  Export                              Upload history can be exported with
                                      YouTube IDs and URLs.
  -----------------------------------------------------------------------

### 10.1 Test scenarios

Must pass before release: - Add several folders and scan them
together. - Scan nested folders with recursion enabled and disabled. -
Add a video while monitoring is enabled. - Add a file that is still
copying; verify it is not processed prematurely. - Discover the same
file through two selected folder paths. - Modify a video after metadata
generation; verify metadata becomes stale. - Regenerate only the
title. - Disconnect the internet during upload. - Close the application
during upload and restart it. - Simulate an uncertain upload response. -
Exhaust or simulate API quota exhaustion. - Trigger a channel
upload-limit error. - Expire/revoke OAuth authorization. - Disconnect a
selected drive. - Attempt to upload an invalid or unsupported MP4. -
Verify that no source file is modified or deleted. - Verify that logs
contain no tokens or API secrets.

------------------------------------------------------------------------

## 11. Development roadmap

### Phase 0 --- Technical validation

Deliverables: - Confirm current YouTube API upload behavior, quota
model, OAuth requirements, and channel restrictions from official
documentation. - Create a Google Cloud project and configure OAuth for
development. - Verify one test upload to a private/unlisted test channel
or test account as appropriate. - Validate FFmpeg packaging and
licensing. - Validate selected AI provider's image/audio input, pricing,
data handling, and rate limits.

Exit criteria: a small technical proof demonstrates local file
selection, metadata generation, OAuth, and one successful resumable
upload.

### Phase 1 --- Desktop foundation

Deliverables: - Electron + React + TypeScript application. - Secure
preload bridge and IPC validation. - Folder selection and persistent
folder settings. - SQLite schema and migrations. - Basic dashboard and
logs.

Exit criteria: selected folders persist after restart and can be scanned
safely.

### Phase 2 --- Discovery and media inspection

Deliverables: - Recursive MP4 scanner. - File stability detection. -
FFprobe metadata extraction. - Fingerprinting and duplicate detection. -
Video library UI.

Exit criteria: repeat scans do not create duplicate records for
unchanged files.

### Phase 3 --- AI profiles and metadata generation

Deliverables: - AI profile CRUD. - Folder-to-profile assignment. -
FFmpeg representative-frame extraction. - AI provider adapter. -
Structured metadata generation and validation. - Metadata editor and
regeneration controls.

Exit criteria: videos in different folders use the correct prompts and
produce editable title/description/hashtag results.

### Phase 4 --- YouTube integration

Deliverables: - Google OAuth. - Channel confirmation. - Secure token
storage. - Single-video resumable upload. - Visibility and metadata
settings. - YouTube video ID and status tracking.

Exit criteria: one video can be uploaded, recovered where supported, and
correctly recorded.

### Phase 5 --- Bulk queue and reliability

Deliverables: - Persistent upload queue. - Separate AI and upload
workers. - Retry/backoff. - Pause/resume. - Quota and channel-limit
handling. - Uncertain-outcome reconciliation. - Startup recovery.

Exit criteria: failure and restart test scenarios pass without silent
job loss or unsafe duplicate uploads.

### Phase 6 --- Scheduling and reporting

Deliverables: - Daily local cap. - Minimum upload interval. - Publishing
windows. - Folder monitoring. - Upload history and CSV export. -
Optional Google Sheets export.

Exit criteria: user can operate a controlled publishing workflow and
audit all outcomes.

### Phase 7 --- Packaging and release

Deliverables: - Windows installer. - Signed application binaries where
feasible. - Bundled or managed FFmpeg distribution. - Secure settings
and log locations. - Update strategy. - User documentation and
troubleshooting guide. - OAuth verification/compliance review for
intended distribution.

------------------------------------------------------------------------

## 12. Risks and mitigations

  -----------------------------------------------------------------------
  Risk                    Impact                  Mitigation
  ----------------------- ----------------------- -----------------------
  YouTube channel daily   Uploads stop            Detect and pause; do
  limit                   unexpectedly            not promise a universal
                                                  limit

  API quota changes       Upload capacity changes Keep quota rules
                                                  configurable and verify
                                                  official docs

  OAuth verification      Public release may be   Validate distribution
  requirements            delayed                 model and scopes early

  AI misinterprets a clip Misleading              Representative
                          title/description       sampling, confidence
                                                  flag, review mode

  AI provider cost        Unexpected operating    Usage tracking,
                          cost                    caching, per-folder
                                                  settings

  Large video files       Memory or disk pressure Streaming I/O and
                                                  bounded temporary
                                                  storage

  Network interruption    Partial upload          Resumable upload and
                                                  persistent state

  Crash during upload     Uncertain result or     Reconciliation state
                          duplicate               and conservative
                                                  recovery

  Duplicate files         Repeated publication    Content fingerprint and
                                                  upload history

  Folder                  Missing source files    Preserve records and
  moves/disconnected                              show unavailable status
  drives                                          

  Electron security flaw  Local credential/data   Hardened renderer,
                          exposure                validated IPC, secure
                                                  storage

  API/provider outage     Queue stalls            Backoff, clear status,
                                                  manual retry
  -----------------------------------------------------------------------

------------------------------------------------------------------------

## 13. Decisions to finalize before implementation

These are the remaining product decisions. Use sensible defaults for the
MVP if the user does not specify otherwise.

  Decision              Recommended default
  --------------------- --------------------------------------------------
  Operating system      Windows 10/11, 64-bit
  Source                Local folders only
  File types            MP4 only
  Nested folders        Enabled by default, configurable
  Folder monitoring     Optional, disabled until enabled
  Publishing mode       Manual review by default
  Visibility            Public, configurable per folder
  Upload concurrency    1
  AI concurrency        2
  AI analysis           Representative frames first; optional audio
  AI provider           Provider adapter; choose one for initial release
  Database              SQLite
  Backend               No hosted backend for single-user MVP
  History export        CSV first; Google Sheets later
  Playlist assignment   Optional
  Captions/subtitles    Out of scope

------------------------------------------------------------------------

## 14. Definition of done for MVP

The MVP is complete when a user can:

1.  Install and open LocalTube on Windows.
2.  Connect and confirm a YouTube channel.
3.  Select multiple local folders.
4.  Scan only those folders for MP4 files.
5.  Detect duplicates and wait for files to finish copying.
6.  Assign different AI profiles to different folders.
7.  Generate titles, descriptions, and hashtags from video content.
8.  Edit and approve metadata.
9.  Queue multiple videos for upload.
10. Upload using resumable uploads with visible progress.
11. Pause, resume, and recover jobs safely.
12. Detect quota and channel-limit errors without attempting to bypass
    them.
13. See the YouTube video ID, URL, and processing status.
14. Restart the application without losing queue history.
15. Export upload history to CSV.
16. Confirm that source files remain untouched.

**Release standard:** No silent job loss, no unsafe blind retry after
uncertain upload outcomes, no exposure of credentials, and no
source-file modification.

------------------------------------------------------------------------

## 15. Official documentation to verify during implementation

Use official documentation as the source of truth. Quotas, OAuth
requirements, API behavior, and policy requirements can change.

-   YouTube Data API overview: https://developers.google.com/youtube/v3
-   YouTube `videos.insert`:
    https://developers.google.com/youtube/v3/docs/videos/insert
-   YouTube API quota calculator and quota guidance:
    https://developers.google.com/youtube/v3/determine_quota_cost
-   YouTube API Services policies:
    https://developers.google.com/youtube/terms/developer-policies
-   Google OAuth for desktop applications:
    https://developers.google.com/identity/protocols/oauth2/native-app
-   Electron security guidance:
    https://www.electronjs.org/docs/latest/tutorial/security
-   FFmpeg documentation: https://ffmpeg.org/documentation.html

------------------------------------------------------------------------

## Final recommendation

Build LocalTube as a Windows-first, local-first desktop application
using Electron, React, TypeScript, SQLite, FFmpeg, an AI provider
adapter, and the YouTube Data API.

Keep the first release focused: local folder selection, MP4 discovery,
folder-specific AI metadata generation, manual review, and reliable
resumable uploads. Add monitoring, scheduling, and Google Sheets export
after the core workflow is proven.

The most important engineering investment is the persistent queue and
recovery logic. A polished dashboard is useful, but a dependable
publishing engine is what makes this product valuable.
