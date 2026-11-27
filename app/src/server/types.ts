export type DiscoveryStatus = 'DISCOVERED' | 'WAITING_FOR_STABLE_FILE' | 'VALIDATING' | 'VALID' | 'INVALID' | 'UNAVAILABLE' | 'DUPLICATE' | 'SKIPPED';
export type MetadataStatus = 'NOT_STARTED' | 'ANALYZING' | 'GENERATING' | 'READY' | 'STALE' | 'FAILED';
export type ApprovalStatus = 'NOT_REQUIRED' | 'PENDING' | 'APPROVED' | 'REJECTED';
export type UploadStatus =
  | 'NOT_QUEUED' | 'QUEUED' | 'UPLOADING' | 'UPLOAD_PAUSED' | 'UPLOAD_COMPLETE' | 'UPLOAD_OUTCOME_UNKNOWN'
  | 'RETRY_WAIT' | 'BLOCKED_BY_QUOTA' | 'BLOCKED_BY_CHANNEL_LIMIT' | 'FAILED_PERMANENTLY' | 'CANCELLED';
export type ProcessingStatus = 'NOT_CHECKED' | 'PROCESSING' | 'READY' | 'REJECTED' | 'STATUS_UNKNOWN';
export type Visibility = 'public' | 'unlisted' | 'private';

export const TERMINAL_JOB_STATUSES: UploadStatus[] = ['UPLOAD_COMPLETE', 'FAILED_PERMANENTLY', 'CANCELLED'];
