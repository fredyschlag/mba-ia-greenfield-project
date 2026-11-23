import { randomUUID } from 'node:crypto';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import queueConfig from '../config/queue.config';
import { TEST_VIDEO_PROCESSING_DLQ_URL } from '../test/test-environment';
import {
  createTestSqsClient,
  purgeTestQueues,
  queueDepth,
  sendRawTestMessage,
} from '../test/test-queues';
import { QueueModule } from './queue.module';
import { VideoProcessingQueueService } from './video-processing-queue.service';

const TEST_TIMEOUT_MS = 20_000;

describe('VideoProcessingQueueService (integration)', () => {
  let moduleRef: TestingModule;
  let queue: VideoProcessingQueueService;
  let sqs: SQSClient;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
    }).compile();
    queue = moduleRef.get(VideoProcessingQueueService);
    sqs = createTestSqsClient();
  });

  afterAll(async () => {
    await purgeTestQueues(sqs);
    sqs.destroy();
    await moduleRef.close();
  });

  beforeEach(async () => {
    await purgeTestQueues(sqs);
  });

  it('should receive an enqueued message with its payload', async () => {
    const videoId = randomUUID();

    await queue.enqueue(videoId);
    const message = await queue.receive(0);

    expect(message?.videoId).toBe(videoId);
    expect(message?.receiveCount).toBe(1);
    expect(message?.receiptHandle).toEqual(expect.any(String));
  });

  it('should return null from an empty queue without waiting', async () => {
    const startedAt = Date.now();

    await expect(queue.receive(0)).resolves.toBeNull();

    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it('should expose an invalid payload as a null videoId', async () => {
    await sendRawTestMessage(sqs, JSON.stringify({ videoId: 'not-a-uuid' }));

    const message = await queue.receive(0);

    expect(message?.videoId).toBeNull();
    expect(message?.receiptHandle).toEqual(expect.any(String));
  });

  it(
    'should return an unconfirmed message when its visibility ends',
    async () => {
      const videoId = randomUUID();
      await queue.enqueue(videoId);
      const first = await queue.receive(0);

      await queue.changeVisibility(first!.receiptHandle, 1);
      await expect(queue.receive(0)).resolves.toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      const second = await queue.receive(0);

      expect(second?.videoId).toBe(videoId);
      expect(second?.receiveCount).toBe(2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'should delay the next delivery by the requested visibility',
    async () => {
      await queue.enqueue(randomUUID());
      const message = await queue.receive(0);

      await queue.changeVisibility(message!.receiptHandle, 3);
      await new Promise((resolve) => setTimeout(resolve, 1_200));

      await expect(queue.receive(0)).resolves.toBeNull();
      await expect(queueDepth(sqs)).resolves.toEqual({
        visible: 0,
        inFlight: 1,
      });
    },
    TEST_TIMEOUT_MS,
  );

  it('should not deliver a deleted message again', async () => {
    await queue.enqueue(randomUUID());
    const message = await queue.receive(0);

    await queue.delete(message!.receiptHandle);

    await expect(queueDepth(sqs)).resolves.toEqual({ visible: 0, inFlight: 0 });
    await expect(queue.receive(0)).resolves.toBeNull();
  });

  it(
    'should move a message to the DLQ after 4 unconfirmed receives',
    async () => {
      const videoId = randomUUID();
      await queue.enqueue(videoId);

      for (let attempt = 1; attempt <= 4; attempt += 1) {
        const message = await queue.receive(0);
        expect(message?.receiveCount).toBe(attempt);
        await queue.changeVisibility(message!.receiptHandle, 0);
      }

      await expect(queue.receive(0)).resolves.toBeNull();
      await expect(
        queueDepth(sqs, TEST_VIDEO_PROCESSING_DLQ_URL),
      ).resolves.toEqual({ visible: 1, inFlight: 0 });

      const deadLetter = await queue.receiveDeadLetter(0);
      expect(deadLetter?.videoId).toBe(videoId);

      await queue.deleteDeadLetter(deadLetter!.receiptHandle);
      await expect(
        queueDepth(sqs, TEST_VIDEO_PROCESSING_DLQ_URL),
      ).resolves.toEqual({ visible: 0, inFlight: 0 });
    },
    TEST_TIMEOUT_MS,
  );
});
