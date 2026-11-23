import { type MediaFormat, resolveContentType } from './media-allowlist';

const MP4_FORMAT = 'mov,mp4,m4a,3gp,3g2,mj2';
const MATROSKA_FORMAT = 'matroska,webm';

function mp4(overrides: Partial<MediaFormat> = {}): MediaFormat {
  return {
    formatName: MP4_FORMAT,
    ebmlDocType: null,
    videoCodec: 'h264',
    audioCodec: 'aac',
    pixelFormat: 'yuv420p',
    ...overrides,
  };
}

function webm(overrides: Partial<MediaFormat> = {}): MediaFormat {
  return {
    formatName: MATROSKA_FORMAT,
    ebmlDocType: 'webm',
    videoCodec: 'vp9',
    audioCodec: 'opus',
    pixelFormat: 'yuv420p',
    ...overrides,
  };
}

describe('resolveContentType', () => {
  it.each(['aac', 'mp3', null])(
    'should accept MP4 with h264 and audio %s',
    (audioCodec) => {
      expect(resolveContentType(mp4({ audioCodec }))).toBe('video/mp4');
    },
  );

  it.each(['yuv420p', 'yuvj420p'])(
    'should accept MP4 with pixel format %s',
    (pixelFormat) => {
      expect(resolveContentType(mp4({ pixelFormat }))).toBe('video/mp4');
    },
  );

  describe.each(['vp8', 'vp9', 'av1'])('WebM with %s', (videoCodec) => {
    it.each(['opus', 'vorbis', null])(
      'should accept audio %s',
      (audioCodec) => {
        expect(resolveContentType(webm({ videoCodec, audioCodec }))).toBe(
          'video/webm',
        );
      },
    );
  });

  it.each(['hevc', 'vp9', 'av1', 'mpeg4'])(
    'should reject MP4 with video codec %s',
    (videoCodec) => {
      expect(resolveContentType(mp4({ videoCodec }))).toBeNull();
    },
  );

  it.each(['opus', 'ac3', 'flac'])(
    'should reject MP4 with audio codec %s',
    (audioCodec) => {
      expect(resolveContentType(mp4({ audioCodec }))).toBeNull();
    },
  );

  it.each(['h264', 'hevc'])(
    'should reject WebM with video codec %s',
    (videoCodec) => {
      expect(resolveContentType(webm({ videoCodec }))).toBeNull();
    },
  );

  it.each(['aac', 'mp3'])(
    'should reject WebM with audio codec %s',
    (audioCodec) => {
      expect(resolveContentType(webm({ audioCodec }))).toBeNull();
    },
  );

  it.each(['yuv420p10le', 'yuv422p', 'yuv444p', 'gray'])(
    'should reject pixel format %s',
    (pixelFormat) => {
      expect(resolveContentType(mp4({ pixelFormat }))).toBeNull();
      expect(resolveContentType(webm({ pixelFormat }))).toBeNull();
    },
  );

  it.each(['matroska', null])(
    'should reject Matroska whose DocType is %s',
    (ebmlDocType) => {
      expect(resolveContentType(webm({ ebmlDocType }))).toBeNull();
    },
  );

  it.each(['avi', 'mpegts', 'flv'])(
    'should reject container %s',
    (formatName) => {
      expect(resolveContentType(mp4({ formatName }))).toBeNull();
    },
  );
});
