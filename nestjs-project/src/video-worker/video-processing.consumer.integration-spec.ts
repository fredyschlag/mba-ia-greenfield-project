import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource, type Repository } from 'typeorm';
import { VideoProcessingQueueService } from '../queue/video-processing-queue.service';
import { videoSourceKey, videoThumbnailKey } from '../storage/storage-keys';
import { StorageService } from '../storage/storage.service';
import { cleanAllTables } from '../test/create-test-data-source';
import {
  createTestSqsClient,
  purgeTestQueues,
  queueDepth,
  sendRawTestMessage,
} from '../test/test-queues';
import {
  createTestChannel,
  generateMp4Fixture,
  insertTestVideo,
} from '../test/video-fixtures';
import { VideoStatus } from '../videos/entities/video-status.enum';
import { Video } from '../videos/entities/video.entity';
import { VideoProcessingConsumer } from './video-processing.consumer';
import { VideoWorkerModule } from './video-worker.module';

const SETUP_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 60_000;
const POLL_SECONDS = 2;

describe('VideoProcessingConsumer (integration)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let storage: StorageService;
  let queue: VideoProcessingQueueService;
  let consumer: VideoProcessingConsumer;
  let videos: Repository<Video>;
  let sqs: SQSClient;
  let workDir: string;
  let mp4: Buffer;
  let channelId: string;
  const createdVideoIds: string[] = [];

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'video-consumer-'));
    mp4 = await generateMp4Fixture(workDir);
    moduleRef = await Test.createTestingModule({
      imports: [VideoWorkerModule],
    }).compile();
    moduleRef.useLogger(false);
    dataSource = moduleRef.get(DataSource);
    storage = moduleRef.get(StorageService, { strict: false });
    queue = moduleRef.get(VideoProcessingQueueService, { strict: false });
    consumer = moduleRef.get(VideoProcessingConsumer);
    videos = dataSource.getRepository(Video);
    sqs = createTestSqsClient();
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await purgeTestQueues(sqs);
    sqs.destroy();
    await moduleRef.close();
    await rm(workDir, { recursive: true, force: true });
  }, TEST_TIMEOUT_MS);

  beforeEach(async () => {
    await purgeTestQueues(sqs);
    await cleanAllTables(dataSource);
    ({ id: channelId } = await createTestChannel(dataSource));
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    for (const id of createdVideoIds.splice(0)) {
      await storage.deleteObject(videoSourceKey(id));
      await storage.deleteObject(videoThumbnailKey(id));
    }
  }, TEST_TIMEOUT_MS);

  it(
    'should process a real queue message until ready and remove it',
    async () => {
      const video = await insertTestVideo(dataSource, channelId);
      createdVideoIds.push(video.id);
      await storage.putObject(videoSourceKey(video.id), mp4);
      await queue.enqueue(video.id);

      await expect(consumer.pollOnce(POLL_SECONDS)).resolves.toBe(true);

      const stored = await videos.findOneByOrFail({ id: video.id });
      expect(stored.status).toBe(VideoStatus.READY);
      expect(stored.thumbnail_key).toBe(videoThumbnailKey(video.id));
      await expect(queueDepth(sqs)).resolves.toEqual({
        visible: 0,
        inFlight: 0,
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'should remove a duplicate message without changing the video',
    async () => {
      const video = await insertTestVideo(dataSource, channelId, {
        status: VideoStatus.READY,
      });
      const before = await videos.findOneByOrFail({ id: video.id });
      await queue.enqueue(video.id);

      await consumer.pollOnce(POLL_SECONDS);

      await expect(videos.findOneByOrFail({ id: video.id })).resolves.toEqual(
        before,
      );
      await expect(queueDepth(sqs)).resolves.toEqual({
        visible: 0,
        inFlight: 0,
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'should discard an invalid payload',
    async () => {
      await sendRawTestMessage(sqs, 'not-json');

      await consumer.pollOnce(POLL_SECONDS);

      await expect(queueDepth(sqs)).resolves.toEqual({
        visible: 0,
        inFlight: 0,
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'should hide the message for the backoff after a transient failure',
    async () => {
      const video = await insertTestVideo(dataSource, channelId);
      await queue.enqueue(video.id);
      const changeVisibility = jest.spyOn(queue, 'changeVisibility');

      await consumer.pollOnce(POLL_SECONDS);

      expect(changeVisibility).toHaveBeenCalledWith(expect.any(String), 30);
      await expect(queueDepth(sqs)).resolves.toEqual({
        visible: 0,
        inFlight: 1,
      });
      const stored = await videos.findOneByOrFail({ id: video.id });
      expect(stored.status).toBe(VideoStatus.PROCESSING);
    },
    TEST_TIMEOUT_MS,
  );
});
