-- Version 2: keep the original clip-JSON entry with each title (so it can be restored and improved
-- with Gemini later) and track the improvement of each video.
ALTER TABLE video_metadata ADD COLUMN source_json TEXT;
ALTER TABLE video_metadata ADD COLUMN source_hash TEXT;
ALTER TABLE videos ADD COLUMN enhance_status TEXT NOT NULL DEFAULT 'NONE';
CREATE INDEX idx_videos_enhance ON videos(enhance_status);
