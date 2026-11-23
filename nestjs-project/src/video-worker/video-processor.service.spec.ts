import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { StorageService } from '../storage/storage.service';
import { VideoStatus } from '../videos/entities/video-status.enum';
import { Video } from '../videos/entities/video.entity';
import { FfmpegService, type MediaProbe } from './ffmpeg.service';
import { MediaToolError, MediaUnreadableError } from './media.errors';
import { VideoProcessorService } from './video-processor.service';

const VIDEO_ID = '11111111-1111-4111-8111-111111111111';
const SOURCE_URL = 'http://minio:9000/signed';
const JPEG = Buffer.from([0xff, 0xd8, 0xff]);

const SUPPORTED_MEDIA: MediaProbe = {
  durationSeconds: 12.5,
  width: 1280,
  height: 720,
  formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
  container: 'mp4',
  ebmlDocType: null,
  videoCodec: 'h264',
  audioCodec: 'aac',
  pixelFormat: 'yuv420p',
};

describe('VideoProcessorService', () => {
  let service: VideoProcessorService;
  const repository = { findOne: jest.fn(), update: jest.fn() };
  const storage = {
    signInternalGetObject: jest.fn(),
    putObject: jest.fn(),
  };
  const ffmpeg = { probe: jest.fn(), extractThumbnail: jest.fn() };

  beforeEach(async () => {
    jest.resetAllMocks();
    repository.findOne.mockResolvedValue({
      id: VIDEO_ID,
      status: VideoStatus.PROCESSING,
    });
    repository.update.mockResolvedValue({ affected: 1 });
    storage.signInternalGetObject.mockResolvedValue(SOURCE_URL);
    ffmpeg.probe.mockResolvedValue(SUPPORTED_MEDIA);
    ffmpeg.extractThumbnail.mockResolvedValue(JPEG);

    const moduleRef = await Test.createTestingModule({
      providers: [
        VideoProcessorService,
        { provide: getRepositoryToken(Video), useValue: repository },
        { provide: StorageService, useValue: storage },
        { provide: FfmpegService, useValue: ffmpeg },
      ],
    }).compile();
    moduleRef.useLogger(false);
    service = moduleRef.get(VideoProcessorService);
  });

  it.each([VideoStatus.DRAFT, VideoStatus.READY, VideoStatus.FAILED])(
    'should skip a video in %s without reading the file',
    async (status) => {
      repository.findOne.mockResolvedValue({ id: VIDEO_ID, status });

      await expect(service.process(VIDEO_ID)).resolves.toBe('skipped');

      expect(ffmpeg.probe).not.toHaveBeenCalled();
      expect(repository.update).not.toHaveBeenCalled();
    },
  );

  it('should skip a video that no longer exists', async () => {
    repository.findOne.mockResolvedValue(null);

    await expect(service.process(VIDEO_ID)).resolves.toBe('skipped');
  });

  it('should write ready and all metadata in a single conditional update', async () => {
    await expect(service.process(VIDEO_ID)).resolves.toBe('ready');

    expect(storage.putObject).toHaveBeenCalledWith(
      `videos/${VIDEO_ID}/thumbnail.jpg`,
      JPEG,
      'image/jpeg',
    );
    expect(repository.update).toHaveBeenCalledTimes(1);
    expect(repository.update).toHaveBeenCalledWith(
      { id: VIDEO_ID, status: VideoStatus.PROCESSING },
      {
        status: VideoStatus.READY,
        content_type: 'video/mp4',
        duration_seconds: 12.5,
        width: 1280,
        height: 720,
        container: 'mp4',
        video_codec: 'h264',
        audio_codec: 'aac',
        thumbnail_key: `videos/${VIDEO_ID}/thumbnail.jpg`,
      },
    );
  });

  it('should pass the abort signal to FFmpeg', async () => {
    const { signal } = new AbortController();

    await service.process(VIDEO_ID, signal);

    expect(ffmpeg.probe).toHaveBeenCalledWith(SOURCE_URL, signal);
    expect(ffmpeg.extractThumbnail).toHaveBeenCalledWith(
      SOURCE_URL,
      12.5,
      signal,
    );
  });

  it('should report skipped when another execution finished first', async () => {
    repository.update.mockResolvedValue({ affected: 0 });

    await expect(service.process(VIDEO_ID)).resolves.toBe('skipped');
  });

  it('should fail a format outside the allowlist without a thumbnail', async () => {
    ffmpeg.probe.mockResolvedValue({ ...SUPPORTED_MEDIA, videoCodec: 'hevc' });

    await expect(service.process(VIDEO_ID)).resolves.toBe('failed');

    expect(ffmpeg.extractThumbnail).not.toHaveBeenCalled();
    expect(repository.update).toHaveBeenCalledWith(
      { id: VIDEO_ID, status: VideoStatus.PROCESSING },
      expect.objectContaining({
        status: VideoStatus.FAILED,
        failure_code: 'UNSUPPORTED_FORMAT',
      }),
    );
  });

  it.each(['probe', 'extractThumbnail'] as const)(
    'should fail an unreadable file reported by %s',
    async (method) => {
      ffmpeg[method].mockRejectedValue(new MediaUnreadableError('invalid'));

      await expect(service.process(VIDEO_ID)).resolves.toBe('failed');

      expect(storage.putObject).not.toHaveBeenCalled();
    },
  );

  it('should propagate a transient failure without changing the video', async () => {
    const failure = new MediaToolError('Connection refused');
    ffmpeg.probe.mockRejectedValue(failure);

    await expect(service.process(VIDEO_ID)).rejects.toBe(failure);

    expect(repository.update).not.toHaveBeenCalled();
  });

  it('should propagate a thumbnail upload failure', async () => {
    const failure = new Error('storage unavailable');
    storage.putObject.mockRejectedValue(failure);

    await expect(service.process(VIDEO_ID)).rejects.toBe(failure);

    expect(repository.update).not.toHaveBeenCalled();
  });
});
