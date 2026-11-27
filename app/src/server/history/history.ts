import type { Db } from '../db/db.js';

export interface HistoryRow {
  job_id: number;
  video_id: number;
  folder: string;
  file_path: string;
  filename: string;
  fingerprint: string;
  file_size_bytes: number | null;
  duration_seconds: number | null;
  ai_profile: string;
  prompt_version: number | null;
  title: string;
  description: string;
  hashtags: string;
  channel_id: string;
  channel_title: string;
  visibility: string;
  upload_started_at: string;
  upload_completed_at: string;
  result: string;
  youtube_video_id: string;
  youtube_url: string;
  processing_status: string;
  /** 1 only when YouTube finished processing and its privacy matches what was requested. */
  published: number;
  error_category: string;
  last_error: string;
  retry_count: number;
}

export interface HistoryQuery {
  text?: string;
  folderId?: number;
  status?: string;
  page?: number;
  pageSize?: number;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Searchable upload history (REP-04). Rows outlive their folders: nothing here joins on folder.is_enabled. */
export function searchHistory(db: Db, q: HistoryQuery): HistoryRow[] {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (q.text) {
    where.push(`(m.title LIKE @t ESCAPE '\\' OR v.filename LIKE @t ESCAPE '\\' OR v.file_path LIKE @t ESCAPE '\\' OR j.youtube_video_id LIKE @t ESCAPE '\\')`);
    params.t = `%${escapeLike(q.text)}%`;
  }
  if (q.folderId !== undefined) {
    where.push('v.folder_id = @folderId');
    params.folderId = q.folderId;
  }
  if (q.status) {
    where.push('j.status = @status');
    params.status = q.status;
  }
  const pageSize = Math.max(1, Math.min(q.pageSize ?? 50, 1_000_000));
  params.limit = pageSize;
  params.offset = (Math.max(1, q.page ?? 1) - 1) * pageSize;
  return db
    .prepare(
      `SELECT j.id AS job_id, v.id AS video_id, f.display_name AS folder, v.file_path, v.filename,
              COALESCE(v.content_hash, '') AS fingerprint, v.file_size_bytes, v.duration_seconds,
              COALESCE(p.name, '') AS ai_profile, m.prompt_version,
              COALESCE(m.title, '') AS title, COALESCE(m.description, '') AS description, COALESCE(m.hashtags_json, '') AS hashtags,
              COALESCE(a.channel_id, '') AS channel_id, COALESCE(a.channel_title, '') AS channel_title,
              j.visibility, COALESCE(j.upload_started_at, '') AS upload_started_at, COALESCE(j.upload_completed_at, '') AS upload_completed_at,
              j.status AS result, COALESCE(j.youtube_video_id, '') AS youtube_video_id,
              CASE WHEN j.youtube_video_id IS NULL THEN '' ELSE 'https://youtu.be/' || j.youtube_video_id END AS youtube_url,
              v.processing_status,
              CASE WHEN j.status = 'UPLOAD_COMPLETE' AND v.processing_status = 'READY' AND v.youtube_privacy = j.visibility THEN 1 ELSE 0 END AS published,
              COALESCE(j.last_error_code, '') AS error_category, COALESCE(j.last_error_message, '') AS last_error, j.attempt_count AS retry_count
       FROM upload_jobs j
       JOIN videos v ON v.id = j.video_id
       JOIN folders f ON f.id = v.folder_id
       LEFT JOIN video_metadata m ON m.id = j.metadata_id
       LEFT JOIN ai_profiles p ON p.id = m.ai_profile_id
       LEFT JOIN youtube_accounts a ON a.id = j.youtube_account_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY j.id DESC LIMIT @limit OFFSET @offset`,
    )
    .all(params) as HistoryRow[];
}

const COLUMNS: (keyof HistoryRow)[] = [
  'folder', 'file_path', 'filename', 'fingerprint', 'file_size_bytes', 'duration_seconds', 'ai_profile', 'prompt_version',
  'title', 'description', 'hashtags', 'channel_id', 'channel_title', 'visibility', 'upload_started_at', 'upload_completed_at',
  'result', 'youtube_video_id', 'youtube_url', 'processing_status', 'published', 'error_category', 'last_error', 'retry_count',
  'job_id', 'video_id',
];
/** Columns holding text from files, folders or the AI: neutralised against spreadsheet formula injection. */
const UNTRUSTED = new Set<keyof HistoryRow>(['folder', 'file_path', 'filename', 'ai_profile', 'title', 'description', 'hashtags', 'last_error']);

function cell(col: keyof HistoryRow, value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (UNTRUSTED.has(col) && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** RFC 4180 CSV (CRLF line endings). */
export function exportCsv(rows: HistoryRow[]): string {
  const lines = [COLUMNS.join(',')];
  for (const r of rows) lines.push(COLUMNS.map((c) => cell(c, r[c])).join(','));
  return lines.join('\r\n') + '\r\n';
}
