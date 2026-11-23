import { Test } from '@nestjs/testing';
import {
  VideoProcessingQueueService,
  type VideoProcessingMessage,
} from '../queue/video-processing-queue.service';
import { MediaToolError } from './media.errors';
import { VideoProcessingConsumer } from './video-processing.consumer';
import { VideoProcessorService } from './video-processor.service';
import {
  VIDEO_JOB_HEARTBEAT_MS,
  VIDEO_JOB_MAX_EXECUTION_MS,
} from './video-worker.constants';

const VIDEO_ID = '11111111-1111-4111-8111-111111111111';

function message(
  overrides: Partial<VideoProcessingMessage> = {},
): VideoProcessingMessage {
  return {
    videoId: VIDEO_ID,
    receiptHandle: 'receipt',
    receiveCount: 1,
    ...overrides,
  };
}

function rejectOnAbort(_id: string, signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      reject(new MediaToolError('aborted'));
    });
  });
}

describe('VideoProcessingConsumer', () => {
  let consumer: VideoProcessingConsumer;
  const queue = {
    receive: jest.fn(),
    delete: jest.fn(),
    changeVisibility: jest.fn(),
  };
  const processor = { process: jest.fn() };

  beforeEach(async () => {
    jest.resetAllMocks();
    queue.delete.mockResolvedValue(undefined);
    queue.changeVisibility.mockResolvedValue(undefined);

    const moduleRef = await Test.createTestingModule({
      providers: [
        VideoProcessingConsumer,
        { provide: VideoProcessingQueueService, useValue: queue },
        { provide: VideoProcessorService, useValue: processor },
      ],
    }).compile();
    moduleRef.useLogger(false);
    consumer = moduleRef.get(VideoProcessingConsumer);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should return false when the queue is empty', async () => {
    queue.receive.mockResolvedValue(null);

    await expect(consumer.pollOnce(0)).resolves.toBe(false);

    expect(processor.process).not.toHaveBeenCalled();
  });

  it.each(['ready', 'failed', 'skipped'])(
    'should delete the message when the outcome is %s',
    async (outcome) => {
      queue.receive.mockResolvedValue(message());
      processor.process.mockResolvedValue(outcome);

      await consumer.pollOnce(0);

      expect(queue.delete).toHaveBeenCalledWith('receipt');
      expect(queue.changeVisibility).not.toHaveBeenCalled();
    },
  );

  it('should discard an invalid payload without processing', async () => {
    queue.receive.mockResolvedValue(message({ videoId: null }));

    await consumer.pollOnce(0);

    expect(processor.process).not.toHaveBeenCalled();
    expect(queue.delete).toHaveBeenCalledWith('receipt');
  });

  it.each([
    [1, 30],
    [2, 60],
    [3, 120],
    [4, 120],
  ])(
    'should back off on receive %i for %i seconds',
    async (receiveCount, seconds) => {
      queue.receive.mockResolvedValue(message({ receiveCount }));
      processor.process.mockRejectedValue(new MediaToolError('network'));

      await consumer.pollOnce(0);

      expect(queue.changeVisibility).toHaveBeenCalledWith('receipt', seconds);
      expect(queue.delete).not.toHaveBeenCalled();
    },
  );

  it('should renew visibility every 40 seconds while running', async () => {
    jest.useFakeTimers();
    queue.receive.mockResolvedValue(message());
    let finish: (value: string) => void = () => undefined;
    processor.process.mockReturnValue(
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
    );

    const polling = consumer.pollOnce(0);
    await jest.advanceTimersByTimeAsync(VIDEO_JOB_HEARTBEAT_MS * 3);

    expect(queue.changeVisibility).toHaveBeenCalledTimes(3);
    expect(queue.changeVisibility).toHaveBeenCalledWith('receipt', 120);

    finish('ready');
    await polling;
    await jest.advanceTimersByTimeAsync(VIDEO_JOB_HEARTBEAT_MS * 2);

    expect(queue.changeVisibility).toHaveBeenCalledTimes(3);
    expect(queue.delete).toHaveBeenCalledWith('receipt');
  });

  it('should keep processing when a heartbeat fails', async () => {
    jest.useFakeTimers();
    queue.receive.mockResolvedValue(message());
    queue.changeVisibility.mockRejectedValueOnce(new Error('queue down'));
    let finish: (value: string) => void = () => undefined;
    processor.process.mockReturnValue(
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
    );

    const polling = consumer.pollOnce(0);
    await jest.advanceTimersByTimeAsync(VIDEO_JOB_HEARTBEAT_MS);
    finish('ready');
    await polling;

    expect(queue.delete).toHaveBeenCalledWith('receipt');
  });

  it('should abort an execution over 30 minutes as transient', async () => {
    jest.useFakeTimers();
    queue.receive.mockResolvedValue(message({ receiveCount: 2 }));
    processor.process.mockImplementation(rejectOnAbort);

    const polling = consumer.pollOnce(0);
    await jest.advanceTimersByTimeAsync(VIDEO_JOB_MAX_EXECUTION_MS);
    await polling;

    expect(queue.changeVisibility).toHaveBeenLastCalledWith('receipt', 60);
    expect(queue.delete).not.toHaveBeenCalled();
  });

  it('should return the message immediately on shutdown', async () => {
    queue.receive.mockResolvedValue(message());
    processor.process.mockImplementation(rejectOnAbort);

    const polling = consumer.pollOnce(0);
    await new Promise((resolve) => setImmediate(resolve));
    await consumer.beforeApplicationShutdown();
    await polling;

    expect(queue.changeVisibility).toHaveBeenCalledWith('receipt', 0);
    expect(queue.delete).not.toHaveBeenCalled();
  });

  it('should stop the loop on shutdown and survive polling errors', async () => {
    queue.receive
      .mockRejectedValueOnce(new Error('queue down'))
      .mockImplementation(
        (_wait: number, signal: AbortSignal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              reject(new Error('aborted'));
            });
          }),
      );
    jest.useFakeTimers();

    consumer.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(queue.receive).toHaveBeenCalledTimes(2);

    await expect(consumer.beforeApplicationShutdown()).resolves.toBeUndefined();
  });
});
