import type { SQSClient } from '@aws-sdk/client-sqs';
import { Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource, type Repository } from 'typeorm';
import { VideoProcessingQueueService } from '../queue/video-processing-queue.service';
import { cleanAllTables } from '../test/create-test-data-source';
import {
  createTestSqsClient,
  peekMessageBodies,
  purgeTestQueues,
  queueDepth,
} from '../test/test-queues';
import { createTestChannel, insertTestVideo } from '../test/video-fixtures';
import { VideoStatus } from '../videos/entities/video-status.enum';
import { Video } from '../videos/entities/video.entity';
import { VideoReconcilerService } from './video-reconciler.service';
import { VideoWorkerModule } from './video-worker.module';

const TEST_TIMEOUT_MS = 30_000;

describe('VideoReconcilerService (integration)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let service: VideoReconcilerService;
  let queue: VideoProcessingQueueService;
  let videos: Repository<Video>;
  let sqs: SQSClient;
  let channelId: string;

  async function age(
    id: string,
    column: 'updated_at' | 'job_enqueued_at',
    interval: string,
  ): Promise<void> {
    await dataSource.query(
      `UPDATE "videos" SET "${column}" = now() - CAST($1 AS interval) WHERE "id" = $2`,
      [interval, id],
    );
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [VideoWorkerModule],
    }).compile();
    moduleRef.useLogger(false);
    dataSource = moduleRef.get(DataSource);
    service = moduleRef.get(VideoReconcilerService);
    queue = moduleRef.get(VideoProcessingQueueService, { strict: false });
    videos = dataSource.getRepository(Video);
    sqs = createTestSqsClient();
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await purgeTestQueues(sqs);
    sqs.destroy();
    await moduleRef.close();
  }, TEST_TIMEOUT_MS);

  beforeEach(async () => {
    await purgeTestQueues(sqs);
    await cleanAllTables(dataSource);
    ({ id: channelId } = await createTestChannel(dataSource));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it(
    'should resend a video without a job for over 1 minute',
    async () => {
      const video = await insertTestVideo(dataSource, channelId);
      await age(video.id, 'updated_at', '2 minutes');

      await expect(service.reconcile()).resolves.toBe(1);

      await expect(peekMessageBodies(sqs)).resolves.toEqual([
        JSON.stringify({ videoId: video.id }),
      ]);
      const stored = await videos.findOneByOrFail({ id: video.id });
      expect(stored.job_enqueued_at).not.toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'should not resend a video without a job for under 1 minute',
    async () => {
      await insertTestVideo(dataSource, channelId);

      await expect(service.reconcile()).resolves.toBe(0);

      await expect(queueDepth(sqs)).resolves.toEqual({
        visible: 0,
        inFlight: 0,
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'should not resend a video enqueued less than 2h30 ago',
    async () => {
      const video = await insertTestVideo(dataSource, channelId, {
        job_enqueued_at: new Date(),
      });
      await age(video.id, 'job_enqueued_at', '149 minutes');
      await age(video.id, 'updated_at', '149 minutes');

      await expect(service.reconcile()).resolves.toBe(0);

      await expect(queueDepth(sqs)).resolves.toEqual({
        visible: 0,
        inFlight: 0,
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'should resend a video enqueued over 2h30 ago and refresh the field',
    async () => {
      const video = await insertTestVideo(dataSource, channelId, {
        job_enqueued_at: new Date(),
      });
      await age(video.id, 'job_enqueued_at', '151 minutes');
      const before = await videos.findOneByOrFail({ id: video.id });

      await expect(service.reconcile()).resolves.toBe(1);

      const after = await videos.findOneByOrFail({ id: video.id });
      expect(after.job_enqueued_at!.getTime()).toBeGreaterThan(
        before.job_enqueued_at!.getTime(),
      );
      await expect(service.reconcile()).resolves.toBe(0);
      await expect(queueDepth(sqs)).resolves.toEqual({
        visible: 1,
        inFlight: 0,
      });
    },
    TEST_TIMEOUT_MS,
  );

  it.each([VideoStatus.DRAFT, VideoStatus.READY, VideoStatus.FAILED])(
    'should ignore a video in %s',
    async (status) => {
      const video = await insertTestVideo(dataSource, channelId, { status });
      await age(video.id, 'updated_at', '3 hours');

      await expect(service.reconcile()).resolves.toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'should not resend the same video from concurrent executions',
    async () => {
      const created = await Promise.all(
        Array.from({ length: 6 }, () => insertTestVideo(dataSource, channelId)),
      );
      for (const video of created) {
        await age(video.id, 'updated_at', '2 minutes');
      }
      const enqueue = jest.spyOn(queue, 'enqueue');

      const [first, second] = await Promise.all([
        service.reconcile(),
        service.reconcile(),
      ]);

      expect(first + second).toBe(created.length);
      const sentIds = enqueue.mock.calls.map(([id]) => id);
      expect(new Set(sentIds).size).toBe(created.length);
      expect(sentIds).toHaveLength(created.length);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'should keep the video eligible when the queue is unavailable',
    async () => {
      const video = await insertTestVideo(dataSource, channelId);
      await age(video.id, 'updated_at', '2 minutes');
      jest.spyOn(queue, 'enqueue').mockRejectedValueOnce(new Error('down'));

      await expect(service.reconcile()).rejects.toThrow('down');

      const stored = await videos.findOneByOrFail({ id: video.id });
      expect(stored.job_enqueued_at).toBeNull();
      await expect(service.reconcile()).resolves.toBe(1);
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
        expect.stringContaining('Reconciliation failed'),
      );
    },
    TEST_TIMEOUT_MS,
  );
});
