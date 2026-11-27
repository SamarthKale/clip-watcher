CREATE TABLE ai_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'gemini',
  model TEXT NOT NULL DEFAULT '',
  title_prompt TEXT NOT NULL DEFAULT '',
  description_prompt TEXT NOT NULL DEFAULT '',
  hashtag_prompt TEXT NOT NULL DEFAULT '',
  fixed_hashtags TEXT NOT NULL DEFAULT '[]',
  language TEXT NOT NULL DEFAULT 'en',
  tone TEXT NOT NULL DEFAULT '',
  target_audience TEXT NOT NULL DEFAULT '',
  generation_settings_json TEXT NOT NULL DEFAULT '{}',
  prompt_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  recursive_scan INTEGER NOT NULL DEFAULT 1,
  monitor_enabled INTEGER NOT NULL DEFAULT 0,
  ai_profile_id INTEGER REFERENCES ai_profiles(id),
  auto_publish INTEGER NOT NULL DEFAULT 1,
  default_visibility TEXT NOT NULL DEFAULT 'public',
  default_category_id TEXT NOT NULL DEFAULT '20',
  default_playlist_id TEXT,
  is_enabled INTEGER NOT NULL DEFAULT 1,
  last_scan_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  folder_id INTEGER NOT NULL REFERENCES folders(id),
  file_path TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  file_size_bytes INTEGER,
  modified_at INTEGER,
  content_hash TEXT,
  duration_seconds REAL,
  width INTEGER,
  height INTEGER,
  frame_rate REAL,
  video_codec TEXT,
  audio_codec TEXT,
  shorts_warning TEXT,
  allow_republish INTEGER NOT NULL DEFAULT 0,
  discovery_status TEXT NOT NULL DEFAULT 'DISCOVERED',
  metadata_status TEXT NOT NULL DEFAULT 'NOT_STARTED',
  approval_status TEXT NOT NULL DEFAULT 'PENDING',
  upload_status TEXT NOT NULL DEFAULT 'NOT_QUEUED',
  processing_status TEXT NOT NULL DEFAULT 'NOT_CHECKED',
  youtube_privacy TEXT,
  processing_detail TEXT,
  processing_checked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_videos_folder ON videos(folder_id);
CREATE INDEX idx_videos_hash ON videos(content_hash);

CREATE TABLE video_metadata (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id INTEGER NOT NULL REFERENCES videos(id),
  ai_profile_id INTEGER REFERENCES ai_profiles(id),
  prompt_version INTEGER,
  provider TEXT,
  model TEXT,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  hashtags_json TEXT NOT NULL DEFAULT '[]',
  category_id TEXT,
  language TEXT,
  confidence TEXT,
  needs_review INTEGER NOT NULL DEFAULT 0,
  is_current INTEGER NOT NULL DEFAULT 1,
  content_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_metadata_video ON video_metadata(video_id, is_current);

CREATE TABLE youtube_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  google_account_label TEXT,
  channel_id TEXT,
  channel_title TEXT,
  secret_ref TEXT,
  confirmed INTEGER NOT NULL DEFAULT 0,
  connected_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_validated_at TEXT,
  is_enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE upload_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id INTEGER NOT NULL REFERENCES videos(id),
  youtube_account_id INTEGER REFERENCES youtube_accounts(id),
  metadata_id INTEGER REFERENCES video_metadata(id),
  visibility TEXT NOT NULL DEFAULT 'public',
  scheduled_at TEXT,
  status TEXT NOT NULL DEFAULT 'QUEUED',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  resumable_session_reference TEXT,
  bytes_sent INTEGER NOT NULL DEFAULT 0,
  data_started INTEGER NOT NULL DEFAULT 0,
  file_fingerprint TEXT,
  youtube_video_id TEXT,
  upload_started_at TEXT,
  upload_completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_jobs_one_active ON upload_jobs(video_id)
  WHERE status NOT IN ('UPLOAD_COMPLETE','FAILED_PERMANENTLY','CANCELLED');
CREATE INDEX idx_jobs_status ON upload_jobs(status);
CREATE INDEX idx_jobs_youtube ON upload_jobs(youtube_video_id);

CREATE TABLE activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  event_type TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  details_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
