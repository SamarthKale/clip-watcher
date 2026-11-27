export interface Folder {
  id: number;
  path: string;
  display_name: string;
  recursive_scan: number;
  monitor_enabled: number;
  ai_profile_id: number | null;
  auto_publish: number;
  default_visibility: 'public' | 'unlisted' | 'private';
  last_scan_at: string | null;
  available: boolean;
}

export interface Profile {
  id: number;
  name: string;
  title_prompt: string;
  description_prompt: string;
  hashtag_prompt: string;
  fixed_hashtags: string;
  language: string;
  tone: string;
  target_audience: string;
  prompt_version: number;
}

export interface VideoRow {
  id: number;
  folder_id: number;
  folder_name: string;
  filename: string;
  file_path: string;
  duration_seconds: number | null;
  file_size_bytes: number | null;
  shorts_warning: string | null;
  discovery_status: string;
  metadata_status: string;
  approval_status: string;
  upload_status: string;
  processing_status: string;
  youtube_privacy: string | null;
  title: string | null;
  description: string | null;
  hashtags_json: string | null;
  confidence: string | null;
  needs_review: number | null;
  ai_profile: string | null;
  youtube_video_id: string | null;
  requested_visibility: string | null;
  youtube_url: string | null;
  last_error: string | null;
  enhance_status: string;
  metadata_source: string | null;
}

export interface Job {
  id: number;
  video_id: number;
  status: string;
  attempt_count: number;
  bytes_sent: number;
  file_size_bytes: number | null;
  filename: string;
  folder_name: string;
  title: string | null;
  youtube_video_id: string | null;
  reason: string;
}

export interface Account {
  id: number;
  channel_id: string;
  channel_title: string;
  confirmed: number;
  is_enabled: number;
  needs_reauth: number;
}

export interface Settings {
  aiConsent: boolean;
  aiWorkers: number;
  uploadWorkers: number;
  tempDir: string;
  stableMs: number;
  geminiModel: string;
  googleClientId: string;
  scanIntervalMin: number;
  queuePaused: boolean;
  geminiKeySet: boolean;
  enhanceImports: boolean;
  publishMode: 'review' | 'auto';
  autoVisibility: 'private' | 'unlisted' | 'public';
  libraryDir: string;
}

export interface HistoryRow {
  job_id: number;
  folder: string;
  filename: string;
  title: string;
  channel_title: string;
  visibility: string;
  upload_completed_at: string;
  result: string;
  youtube_url: string;
  processing_status: string;
  published: number;
  last_error: string;
}
