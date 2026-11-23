import type { SQSClient } from '@aws-sdk/client-sqs';
import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource, type Repository } from 'typeorm';
import { cleanAllTables } from '../test/create-test-data-source';
import { TEST_VIDEO_PROCESSING_DLQ_URL } from '../test/test-environment';
import {
  createTestSqsClient,
  purgeTestQueues,
  queueDepth,
  sendRawTestMessage,
} from '../test/test-queues';
import { createTestChannel, insertTestVideo } from '../test/video-fixtures';
import { VideoStatus } from '../videos/entities/video-status.enum';
import { Video } from '../videos/entities/video.entity';
import { VideoDlqConsumer } from './video-dlq.consumer';
import { VideoWorkerModule } from './video-worker.module';

const TEST_TIMEOUT_MS = 30_000;
const POLL_SECONDS = 2;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const CLOCK_TOLERANCE_MS = 10_000;

describe('VideoDlqConsumer (integration)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let consumer: VideoDlqConsumer;
  let videos: Repository<Video>;
  let sqs: SQSClient;
  let channelId: string;

  function sendDeadLetter(body: string): Promise<void> {
    return sendRawTestMessage(sqs, body, TEST_VIDEO_PROCESSING_DLQ_URL);
  }

  async function expectDlqEmpty(): Promise<void> {
    await expect(
      queueDepth(sqs, TEST_VIDEO_PROCESSING_DLQ_URL),
    ).resolves.toEqual({ visible: 0, inFlight: 0 });
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [VideoWorkerModule],
    }).compile();
    moduleRef.useLogger(false);
    dataSource = moduleRef.get(DataSource);
    consumer = moduleRef.get(VideoDlqConsumer);
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

  it(
    'should fail a processing video and retain its files for 7 days',
    async () => {
      const video = await insertTestVideo(dataSource, channelId);
      await sendDeadLetter(JSON.stringify({ videoId: video.id }));
      const before = Date.now();

      await expect(consumer.pollOnce(POLL_SECONDS)).resolves.toBe(true);

      const stored = await videos.findOneByOrFail({ id: video.id });
      expect(stored.status).toBe(VideoStatus.FAILED);
      expect(stored.failure_code).toBe('PROCESSING_EXHAUSTED');
      const purgeAt = stored.storage_purge_after!.getTime();
      expect(purgeAt).toBeGreaterThanOrEqual(
        before + SEVEN_DAYS_MS - CLOCK_TOLERANCE_MS,
      );
      expect(purgeAt).toBeLessThanOrEqual(
        Date.now() + SEVEN_DAYS_MS + CLOCK_TOLERANCE_MS,
      );
      await expectDlqEmpty();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'should not change a video that is already ready',
    async () => {
      const video = await insertTestVideo(dataSource, channelId, {
        status: VideoStatus.READY,
      });
      const before = await videos.findOneByOrFail({ id: video.id });
      await sendDeadLetter(JSON.stringify({ videoId: video.id }));

      await consumer.pollOnce(POLL_SECONDS);

      await expect(videos.findOneByOrFail({ id: video.id })).resolves.toEqual(
        before,
      );
      await expectDlqEmpty();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'should be idempotent for a duplicated dead letter',
    async () => {
      const video = await insertTestVideo(dataSource, channelId);
      await sendDeadLetter(JSON.stringify({ videoId: video.id }));
      await consumer.pollOnce(POLL_SECONDS);
      const first = await videos.findOneByOrFail({ id: video.id });
      await sendDeadLetter(JSON.stringify({ videoId: video.id }));

      await consumer.pollOnce(POLL_SECONDS);

      await expect(videos.findOneByOrFail({ id: video.id })).resolves.toEqual(
        first,
      );
      await expectDlqEmpty();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'should remove a dead letter with an invalid payload',
    async () => {
      await sendDeadLetter('not-json');

      await expect(consumer.pollOnce(POLL_SECONDS)).resolves.toBe(true);

      await expectDlqEmpty();
    },
    TEST_TIMEOUT_MS,
  );
});
