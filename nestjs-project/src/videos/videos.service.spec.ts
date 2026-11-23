import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ChannelsService } from '../channels/channels.service';
import { StorageService } from '../storage/storage.service';
import { VideoStatus } from './entities/video-status.enum';
import { Video } from './entities/video.entity';
import { buildAttachmentDisposition } from './video-download-filename.util';
import {
  VideoNotFoundException,
  VideoNotReadyException,
} from './video.exceptions';
import { VideosService } from './videos.service';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const CHANNEL_ID = '22222222-2222-4222-8222-222222222222';
const VIDEO_ID = '33333333-3333-4333-8333-333333333333';
const SLUG = 'aZ3kP9xQ1bC';
const SIGNED_URL = 'http://localhost:9000/signed';

function readyVideo(overrides: Partial<Video> = {}): Video {
  return {
    id: VIDEO_ID,
    channel_id: CHANNEL_ID,
    slug: SLUG,
    status: VideoStatus.READY,
    original_filename: 'clip.mp4',
    size_bytes: 2048,
    content_type: 'video/mp4',
    duration_seconds: 60,
    width: 1280,
    height: 720,
    container: 'mp4',
    video_codec: 'h264',
    audio_codec: 'aac',
    thumbnail_key: `videos/${VIDEO_ID}/thumbnail.jpg`,
    failure_code: null,
    created_at: new Date('2026-11-01T10:00:00.000Z'),
    updated_at: new Date('2026-11-01T10:05:00.000Z'),
    ...overrides,
  } as Video;
}

describe('VideosService', () => {
  let service: VideosService;
  const repository = { findOne: jest.fn() };
  const channels = { findByUserId: jest.fn() };
  const storage = { signPublicGetObject: jest.fn() };

  beforeEach(async () => {
    jest.resetAllMocks();
    channels.findByUserId.mockResolvedValue({ id: CHANNEL_ID });
    repository.findOne.mockResolvedValue(readyVideo());
    storage.signPublicGetObject.mockResolvedValue(SIGNED_URL);

    const moduleRef = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: repository },
        { provide: ChannelsService, useValue: channels },
        { provide: StorageService, useValue: storage },
      ],
    }).compile();
    service = moduleRef.get(VideosService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe.each(['getVideo', 'getPlayback', 'getDownload'] as const)(
    '%s authorization',
    (method) => {
      it.each(['short', 'aZ3kP9xQ1bCd', 'aZ3kP9xQ1b-'])(
        'should not query the database for malformed slug %s',
        async (slug) => {
          await expect(service[method](USER_ID, slug)).rejects.toBeInstanceOf(
            VideoNotFoundException,
          );

          expect(channels.findByUserId).not.toHaveBeenCalled();
          expect(repository.findOne).not.toHaveBeenCalled();
        },
      );

      it('should hide the video from a user without a channel', async () => {
        channels.findByUserId.mockResolvedValue(null);

        await expect(service[method](USER_ID, SLUG)).rejects.toBeInstanceOf(
          VideoNotFoundException,
        );
      });

      it('should search only inside the channel of the user', async () => {
        repository.findOne.mockResolvedValue(null);

        await expect(service[method](USER_ID, SLUG)).rejects.toBeInstanceOf(
          VideoNotFoundException,
        );

        expect(repository.findOne).toHaveBeenCalledWith({
          where: { slug: SLUG, channel_id: CHANNEL_ID },
        });
        expect(storage.signPublicGetObject).not.toHaveBeenCalled();
      });
    },
  );

  describe('getVideo', () => {
    it('should return metadata and a 1-hour thumbnail URL when ready', async () => {
      const response = await service.getVideo(USER_ID, SLUG);

      expect(response).toEqual({
        id: VIDEO_ID,
        slug: SLUG,
        status: VideoStatus.READY,
        originalFilename: 'clip.mp4',
        sizeBytes: 2048,
        contentType: 'video/mp4',
        durationSeconds: 60,
        width: 1280,
        height: 720,
        container: 'mp4',
        videoCodec: 'h264',
        audioCodec: 'aac',
        thumbnailUrl: SIGNED_URL,
        failureCode: null,
        createdAt: '2026-11-01T10:00:00.000Z',
        updatedAt: '2026-11-01T10:05:00.000Z',
      });
      expect(storage.signPublicGetObject).toHaveBeenCalledWith(
        `videos/${VIDEO_ID}/thumbnail.jpg`,
        { expiresInSeconds: 3600 },
      );
    });

    it.each([VideoStatus.DRAFT, VideoStatus.PROCESSING, VideoStatus.FAILED])(
      'should not sign a thumbnail in %s',
      async (status) => {
        repository.findOne.mockResolvedValue(readyVideo({ status }));

        const response = await service.getVideo(USER_ID, SLUG);

        expect(response.thumbnailUrl).toBeNull();
        expect(storage.signPublicGetObject).not.toHaveBeenCalled();
      },
    );
  });

  describe('getPlayback', () => {
    it.each([
      [60, 3600],
      [1800, 3600],
      [1800.4, 3601],
      [7200, 14400],
      [302400, 604800],
      [302401, 604800],
    ])(
      'should sign a %d-second video for %d seconds',
      async (duration, seconds) => {
        jest.useFakeTimers({ now: new Date('2026-11-01T00:00:00.000Z') });
        repository.findOne.mockResolvedValue(
          readyVideo({ duration_seconds: duration }),
        );

        const response = await service.getPlayback(USER_ID, SLUG);

        expect(storage.signPublicGetObject).toHaveBeenCalledWith(
          `videos/${VIDEO_ID}/source`,
          {
            expiresInSeconds: seconds,
            responseContentType: 'video/mp4',
            responseContentDisposition: 'inline',
          },
        );
        expect(response).toEqual({
          url: SIGNED_URL,
          expiresAt: new Date(
            Date.UTC(2026, 10, 1) + seconds * 1000,
          ).toISOString(),
        });
      },
    );

    it.each([VideoStatus.DRAFT, VideoStatus.PROCESSING, VideoStatus.FAILED])(
      'should reject a video in %s',
      async (status) => {
        repository.findOne.mockResolvedValue(readyVideo({ status }));

        await expect(service.getPlayback(USER_ID, SLUG)).rejects.toBeInstanceOf(
          VideoNotReadyException,
        );
        expect(storage.signPublicGetObject).not.toHaveBeenCalled();
      },
    );
  });

  describe('getDownload', () => {
    it('should sign an attachment for 6 hours', async () => {
      await service.getDownload(USER_ID, SLUG);

      expect(storage.signPublicGetObject).toHaveBeenCalledWith(
        `videos/${VIDEO_ID}/source`,
        {
          expiresInSeconds: 21600,
          responseContentType: 'video/mp4',
          responseContentDisposition: `attachment; filename="clip.mp4"; filename*=UTF-8''clip.mp4`,
        },
      );
    });

    it.each([VideoStatus.DRAFT, VideoStatus.PROCESSING, VideoStatus.FAILED])(
      'should reject a video in %s',
      async (status) => {
        repository.findOne.mockResolvedValue(readyVideo({ status }));

        await expect(service.getDownload(USER_ID, SLUG)).rejects.toBeInstanceOf(
          VideoNotReadyException,
        );
      },
    );
  });

  describe('buildAttachmentDisposition', () => {
    function asciiName(disposition: string): string {
      return /filename="([^"]*)"/.exec(disposition)![1];
    }

    it('should remove header injection, quotes and path separators', () => {
      const disposition = buildAttachmentDisposition(
        '../"evil"\r\nX-Injected: yes/\\name.mp4',
      );

      expect(disposition).not.toMatch(/[\r\n]/);
      const name = asciiName(disposition);
      expect(name).not.toMatch(/["/\\]/);
      expect(name.endsWith('.mp4')).toBe(true);
    });

    it('should keep accents only in the encoded parameter', () => {
      const disposition = buildAttachmentDisposition('relatório ação.mp4');

      expect(asciiName(disposition)).toBe('relatorio acao.mp4');
      expect(disposition).toContain(
        `filename*=UTF-8''relat%C3%B3rio%20a%C3%A7%C3%A3o.mp4`,
      );
    });

    it('should encode reserved characters of the extended value', () => {
      const disposition = buildAttachmentDisposition("it's (1).mp4");

      expect(disposition).toContain(`filename*=UTF-8''it%27s%20%281%29.mp4`);
    });

    it.each(['', '   ', '...', '\r\n'])(
      'should use a fallback for the name %j',
      (filename) => {
        expect(asciiName(buildAttachmentDisposition(filename))).toBe('video');
      },
    );

    it('should limit the length and keep the extension', () => {
      const name = asciiName(
        buildAttachmentDisposition(`${'a'.repeat(240)}.mp4`),
      );

      expect(name).toHaveLength(150);
      expect(name.endsWith('.mp4')).toBe(true);
    });
  });
});
