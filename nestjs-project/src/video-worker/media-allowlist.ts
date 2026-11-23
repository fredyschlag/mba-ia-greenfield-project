export const SUPPORTED_CONTENT_TYPES = {
  MP4: 'video/mp4',
  WEBM: 'video/webm',
} as const;

export type SupportedContentType =
  (typeof SUPPORTED_CONTENT_TYPES)[keyof typeof SUPPORTED_CONTENT_TYPES];

export interface MediaFormat {
  formatName: string;
  ebmlDocType: string | null;
  videoCodec: string;
  audioCodec: string | null;
  pixelFormat: string;
}

const PIXEL_FORMATS: ReadonlySet<string> = new Set(['yuv420p', 'yuvj420p']);
const MP4_VIDEO_CODECS: ReadonlySet<string> = new Set(['h264']);
const MP4_AUDIO_CODECS: ReadonlySet<string> = new Set(['aac', 'mp3']);
const WEBM_VIDEO_CODECS: ReadonlySet<string> = new Set(['vp8', 'vp9', 'av1']);
const WEBM_AUDIO_CODECS: ReadonlySet<string> = new Set(['opus', 'vorbis']);

export function isMp4Family(formatName: string): boolean {
  return formatName.split(',').includes('mov');
}

export function isMatroskaFamily(formatName: string): boolean {
  return formatName.split(',').includes('matroska');
}

function matchesCodecs(
  media: MediaFormat,
  videoCodecs: ReadonlySet<string>,
  audioCodecs: ReadonlySet<string>,
): boolean {
  return (
    videoCodecs.has(media.videoCodec) &&
    (media.audioCodec === null || audioCodecs.has(media.audioCodec))
  );
}

/** Returns the content type to serve, or null when outside the TD-12 matrix. */
export function resolveContentType(
  media: MediaFormat,
): SupportedContentType | null {
  if (!PIXEL_FORMATS.has(media.pixelFormat)) {
    return null;
  }
  if (
    isMp4Family(media.formatName) &&
    matchesCodecs(media, MP4_VIDEO_CODECS, MP4_AUDIO_CODECS)
  ) {
    return SUPPORTED_CONTENT_TYPES.MP4;
  }
  if (
    isMatroskaFamily(media.formatName) &&
    media.ebmlDocType === 'webm' &&
    matchesCodecs(media, WEBM_VIDEO_CODECS, WEBM_AUDIO_CODECS)
  ) {
    return SUPPORTED_CONTENT_TYPES.WEBM;
  }
  return null;
}
