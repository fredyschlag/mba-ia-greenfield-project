import { Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource, EntityManager, type Repository } from 'typeorm';
import { videoSourceKey, videoThumbnailKey } from '../storage/storage-keys';
import { StorageService } from '../storage/storage.service';
import { cleanAllTables } from '../test/create-test-data-source';
import { createTestChannel, insertTestVideo } from '../test/video-fixtures';
import { VideoStatus } from '../videos/entities/video-status.enum';
import { Video } from '../videos/entities/video.entity';
import { VideoCleanupService } from './video-cleanup.service';
import { VideoWorkerModule } from './video-worker.module';

const TEST_TIMEOUT_MS = 30_000;
const CONTENT = Buffer.from('stored video content');
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

describe('VideoCleanupService (integration)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let storage: StorageService;
  let service: VideoCleanupService;
  let videos: Repository<Video>;
  let channelId: string;
  const usedKeys: { key: string; uploadId?: string }[] = [];

  function past(ms = HOUR_MS): Date {
    return new Date(Date.now() - ms);
  }

  function future(ms = HOUR_MS): Date {
    return new Date(Date.now() + ms);
  }

  async function putTracked(key: string): Promise<void> {
    usedKeys.push({ key });
    await storage.putObject(key, CONTENT);
  }

  async function draftWithMultipart(expiresAt: Date): Promise<Video> {
    const video = await insertTestVideo(dataSource, channelId, {
      status: VideoStatus.DRAFT,
      upload_expires_at: expiresAt,
    });
    const key = videoSourceKey(video.id);
    const uploadId = await storage.createMultipartUpload(key);
    usedKeys.push({ key, uploadId });
    await videos.update({ id: video.id }, { upload_id: uploadId });
    return { ...video, upload_id: uploadId };
  }

  async function failedWithObjects(
    failureCode: string,
    purgeAfter: Date,
  ): Promise<Video> {
    const video = await insertTestVideo(dataSource, channelId, {
      status: VideoStatus.FAILED,
      failure_code: failureCode,
      storage_purge_after: purgeAfter,
    });
    await putTracked(videoSourceKey(video.id));
    await putTracked(videoThumbnailKey(video.id));
    return video;
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [VideoWorkerModule],
    }).compile();
    moduleRef.useLogger(false);
    dataSource = moduleRef.get(DataSource);
    storage = moduleRef.get(StorageService, { strict: false });
    service = moduleRef.get(VideoCleanupService);
    videos = dataSource.getRepository(Video);
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await moduleRef.close();
  }, TEST_TIMEOUT_MS);

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    ({ id: channelId } = await createTestChannel(dataSource));
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    for (const { key, uploadId } of usedKeys.splice(0)) {
      if (uploadId) await storage.abortMultipartUpload(key, uploadId);
      await storage.deleteObject(key);
    }
  }, TEST_TIMEOUT_MS);

  it(
    'should abort the multipart of an expired draft and remove the row',
    async () => {
      const video = await draftWithMultipart(past());

      await expect(service.sweepExpiredDrafts()).resolves.toBe(1);

      await expect(
        storage.listAllParts(videoSourceKey(video.id), video.upload_id!),
      ).resolves.toBeNull();
      await expect(videos.existsBy({ id: video.id })).resolves.toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'should remove the completed source of an expired draft',
    async () => {
      const video = await insertTestVideo(dataSource, channelId, {
        status: VideoStatus.DRAFT,
        upload_expires_at: past(),
        upload_id: 'upload-that-no-longer-exists',
      });
      await putTracked(videoSourceKey(video.id));

      await expect(service.sweepExpiredDrafts()).resolves.toBe(1);

      await expect(
        storage.headObject(videoSourceKey(video.id)),
      ).resolves.toBeNull();
      await expect(videos.existsBy({ id: video.id })).resolves.toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'should keep a draft inside its validity',
    async () => {
      const video = await draftWithMultipart(future());

      await expect(service.sweepExpiredDrafts()).resolves.toBe(0);

      await expect(
        storage.listAllParts(videoSourceKey(video.id), video.upload_id!),
      ).resolves.toEqual([]);
      await expect(videos.existsBy({ id: video.id })).resolves.toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'should keep the objects of an exhausted video during retention',
    async () => {
      const video = await failedWithObjects(
        'PROCESSING_EXHAUSTED',
        future(7 * DAY_MS),
      );

      await expect(service.purgeFailedVideos()).resolves.toBe(0);

      await expect(
        storage.headObject(videoSourceKey(video.id)),
      ).resolves.not.toBeNull();
      await expect(
        storage.headObject(videoThumbnailKey(video.id)),
      ).resolves.not.toBeNull();
      const stored = await videos.findOneByOrFail({ id: video.id });
      expect(stored.storage_purged_at).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  it.each(['UNSUPPORTED_FORMAT', 'PROCESSING_EXHAUSTED'])(
    'should purge a due %s video and keep its row',
    async (failureCode) => {
      const video = await failedWithObjects(failureCode, past());

      await expect(service.purgeFailedVideos()).resolves.toBe(1);

      await expect(
        storage.headObject(videoSourceKey(video.id)),
      ).resolves.toBeNull();
      await expect(
        storage.headObject(videoThumbnailKey(video.id)),
      ).resolves.toBeNull();
      const stored = await videos.findOneByOrFail({ id: video.id });
      expect(stored.status).toBe(VideoStatus.FAILED);
      expect(stored.failure_code).toBe(failureCode);
      expect(stored.storage_purged_at).not.toBeNull();
      await expect(service.purgeFailedVideos()).resolves.toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'should finish on the next run after a crash before the update',
    async () => {
      const video = await failedWithObjects('UNSUPPORTED_FORMAT', past());
      jest
        .spyOn(EntityManager.prototype, 'update')
        .mockRejectedValueOnce(new Error('crash before update'));

      await expect(service.purgeFailedVideos()).resolves.toBe(0);

      await expect(
        storage.headObject(videoSourceKey(video.id)),
      ).resolves.toBeNull();
      const interrupted = await videos.findOneByOrFail({ id: video.id });
      expect(interrupted.storage_purged_at).toBeNull();

      await expect(service.purgeFailedVideos()).resolves.toBe(1);

      const finished = await videos.findOneByOrFail({ id: video.id });
      expect(finished.storage_purged_at).not.toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'should not handle the same video from concurrent replicas',
    async () => {
      const created = await Promise.all(
        Array.from({ length: 5 }, () =>
          insertTestVideo(dataSource, channelId, {
            status: VideoStatus.DRAFT,
            upload_expires_at: past(),
          }),
        ),
      );
      const deleteObject = jest.spyOn(storage, 'deleteObject');

      const [first, second] = await Promise.all([
        service.sweepExpiredDrafts(),
        service.sweepExpiredDrafts(),
      ]);

      expect(first + second).toBe(created.length);
      const keys = deleteObject.mock.calls.map(([key]) => key);
      expect(keys).toHaveLength(created.length);
      expect(new Set(keys).size).toBe(created.length);
      await expect(videos.countBy({ channel_id: channelId })).resolves.toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'should log and keep running when the videos table is missing',
    async () => {
      const logError = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      await dataSource.query('ALTER TABLE "videos" RENAME TO "videos_hidden"');
      try {
        await expect(service.handleSchedule()).resolves.toBeUndefined();
      } finally {
        await dataSource.query(
          'ALTER TABLE "videos_hidden" RENAME TO "videos"',
        );
      }

      expect(logError).toHaveBeenCalledWith(
        expect.stringContaining('Expired draft sweep failed'),
      );
      expect(logError).toHaveBeenCalledWith(
        expect.stringContaining('Failed video purge failed'),
      );
    },
    TEST_TIMEOUT_MS,
  );
});
