import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource, type Repository } from 'typeorm';
import { videoSourceKey, videoThumbnailKey } from '../storage/storage-keys';
import { StorageService } from '../storage/storage.service';
import { cleanAllTables } from '../test/create-test-data-source';
import {
  createTestChannel,
  generateMkvFixture,
  generateMp4Fixture,
  insertTestVideo,
} from '../test/video-fixtures';
import { VideoStatus } from '../videos/entities/video-status.enum';
import { Video } from '../videos/entities/video.entity';
import { MediaToolError } from './media.errors';
import { VideoProcessorService } from './video-processor.service';
import { VideoWorkerModule } from './video-worker.module';

const SETUP_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 60_000;

describe('VideoProcessorService (integration)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let storage: StorageService;
  let service: VideoProcessorService;
  let videos: Repository<Video>;
  let workDir: string;
  let mp4: Buffer;
  let mkv: Buffer;
  let channelId: string;
  const createdVideoIds: string[] = [];

  async function videoWithSource(content: Buffer): Promise<Video> {
    const video = await insertTestVideo(dataSource, channelId);
    createdVideoIds.push(video.id);
    await storage.putObject(videoSourceKey(video.id), content);
    return video;
  }

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'video-processor-'));
    [mp4, mkv] = await Promise.all([
      generateMp4Fixture(workDir),
      generateMkvFixture(workDir),
    ]);
    moduleRef = await Test.createTestingModule({
      imports: [VideoWorkerModule],
    }).compile();
    moduleRef.useLogger(false);
    dataSource = moduleRef.get(DataSource);
    storage = moduleRef.get(StorageService, { strict: false });
    service = moduleRef.get(VideoProcessorService);
    videos = dataSource.getRepository(Video);
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await moduleRef.close();
    await rm(workDir, { recursive: true, force: true });
  }, TEST_TIMEOUT_MS);

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    ({ id: channelId } = await createTestChannel(dataSource));
  });

  afterEach(async () => {
    for (const id of createdVideoIds.splice(0)) {
      await storage.deleteObject(videoSourceKey(id));
      await storage.deleteObject(videoThumbnailKey(id));
    }
  }, TEST_TIMEOUT_MS);

  it(
    'should take a valid video to ready with metadata and thumbnail',
    async () => {
      const video = await videoWithSource(mp4);

      await expect(service.process(video.id)).resolves.toBe('ready');

      const stored = await videos.findOneByOrFail({ id: video.id });
      expect(stored.status).toBe(VideoStatus.READY);
      expect(stored.content_type).toBe('video/mp4');
      expect(stored.duration_seconds).toBeCloseTo(2, 0);
      expect(stored.width).toBe(320);
      expect(stored.height).toBe(180);
      expect(stored.container).toBe('mp4');
      expect(stored.video_codec).toBe('h264');
      expect(stored.audio_codec).toBe('aac');
      expect(stored.thumbnail_key).toBe(videoThumbnailKey(video.id));
      const thumbnail = await storage.headObject(videoThumbnailKey(video.id));
      expect(thumbnail?.contentLength).toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'should fail a refused format with immediate purge',
    async () => {
      const video = await videoWithSource(mkv);
      const before = Date.now();

      await expect(service.process(video.id)).resolves.toBe('failed');

      const stored = await videos.findOneByOrFail({ id: video.id });
      expect(stored.status).toBe(VideoStatus.FAILED);
      expect(stored.failure_code).toBe('UNSUPPORTED_FORMAT');
      expect(stored.storage_purge_after!.getTime()).toBeGreaterThanOrEqual(
        before - 5_000,
      );
      expect(stored.storage_purge_after!.getTime()).toBeLessThanOrEqual(
        Date.now() + 5_000,
      );
      expect(stored.thumbnail_key).toBeNull();
      await expect(
        storage.headObject(videoThumbnailKey(video.id)),
      ).resolves.toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'should fail a file that FFmpeg cannot read',
    async () => {
      const video = await videoWithSource(randomBytes(64 * 1024));

      await expect(service.process(video.id)).resolves.toBe('failed');

      const stored = await videos.findOneByOrFail({ id: video.id });
      expect(stored.failure_code).toBe('UNSUPPORTED_FORMAT');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'should not change a video that is already ready',
    async () => {
      const video = await videoWithSource(mp4);
      await service.process(video.id);
      const first = await videos.findOneByOrFail({ id: video.id });

      await expect(service.process(video.id)).resolves.toBe('skipped');

      const second = await videos.findOneByOrFail({ id: video.id });
      expect(second).toEqual(first);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'should keep the video in processing on a transient failure',
    async () => {
      const video = await insertTestVideo(dataSource, channelId);

      await expect(service.process(video.id)).rejects.toBeInstanceOf(
        MediaToolError,
      );

      const stored = await videos.findOneByOrFail({ id: video.id });
      expect(stored.status).toBe(VideoStatus.PROCESSING);
      expect(stored.failure_code).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );
});
