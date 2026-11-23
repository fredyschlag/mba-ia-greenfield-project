export const FFMPEG_PROTOCOL_WHITELIST = 'http,https,tcp,tls';
// Only the demuxers of the TD-12 matrix. Playlist demuxers such as HLS or
// concat would otherwise follow URLs embedded in an uploaded file.
export const FFMPEG_FORMAT_WHITELIST = 'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm';

export const FFMPEG_IO_TIMEOUT_MICROSECONDS = 30_000_000;
export const FFMPEG_RECONNECT_DELAY_MAX_SECONDS = 5;
export const FFPROBE_TIMEOUT_MS = 2 * 60 * 1000;
export const FFMPEG_THUMBNAIL_TIMEOUT_MS = 5 * 60 * 1000;

export const FFPROBE_MAX_OUTPUT_BYTES = 5 * 1024 * 1024;
export const FFMPEG_THUMBNAIL_MAX_BYTES = 20 * 1024 * 1024;
export const FFMPEG_STDERR_TAIL_BYTES = 8 * 1024;
export const MEDIA_ERROR_DETAIL_LENGTH = 500;

export const THUMBNAIL_POSITION_RATIO = 0.1;
export const THUMBNAIL_JPEG_QUALITY = '3';

export const EBML_HEADER_READ_BYTES = 4096;
export const EBML_HEADER_TIMEOUT_MS = 30_000;

export const VIDEO_JOB_VISIBILITY_SECONDS = 120;
export const VIDEO_JOB_HEARTBEAT_MS = 40_000;
export const VIDEO_JOB_MAX_EXECUTION_MS = 30 * 60 * 1000;
export const VIDEO_JOB_BACKOFF_SECONDS = [30, 60, 120] as const;
// Outlives the execution limit, so the URL never expires during a job.
export const VIDEO_SOURCE_URL_SECONDS = 35 * 60;
export const CONSUMER_ERROR_DELAY_MS = 5_000;

export const RECONCILER_BATCH_SIZE = 100;
export const RECONCILER_NULL_JOB_GRACE = '1 minute';
export const RECONCILER_LOST_JOB_AFTER = '150 minutes';
export const EXHAUSTED_RETENTION = '7 days';
export const CLEANUP_BATCH_SIZE = 100;
