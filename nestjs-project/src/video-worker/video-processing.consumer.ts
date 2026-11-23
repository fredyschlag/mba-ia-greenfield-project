import {
  BeforeApplicationShutdown,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { QUEUE_LONG_POLL_SECONDS } from '../queue/queue.constants';
import {
  VideoProcessingQueueService,
  type VideoProcessingMessage,
} from '../queue/video-processing-queue.service';
import { errorMessage, runPollingLoop } from './polling-loop';
import { VideoProcessorService } from './video-processor.service';
import {
  VIDEO_JOB_BACKOFF_SECONDS,
  VIDEO_JOB_HEARTBEAT_MS,
  VIDEO_JOB_MAX_EXECUTION_MS,
  VIDEO_JOB_VISIBILITY_SECONDS,
} from './video-worker.constants';

@Injectable()
export class VideoProcessingConsumer
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(VideoProcessingConsumer.name);
  private readonly shutdown = new AbortController();
  private loop: Promise<void> | null = null;

  constructor(
    private readonly queue: VideoProcessingQueueService,
    private readonly processor: VideoProcessorService,
  ) {}

  onApplicationBootstrap(): void {
    this.loop = runPollingLoop(
      () => this.pollOnce(),
      this.shutdown.signal,
      this.logger,
    );
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.shutdown.abort();
    await this.loop;
  }

  /** Handles at most one message, keeping one job per replica. */
  async pollOnce(
    waitTimeSeconds: number = QUEUE_LONG_POLL_SECONDS,
  ): Promise<boolean> {
    const message = await this.queue.receive(
      waitTimeSeconds,
      this.shutdown.signal,
    );
    if (!message) {
      return false;
    }
    await this.handle(message);
    return true;
  }

  private async handle(message: VideoProcessingMessage): Promise<void> {
    if (!message.videoId) {
      this.logger.warn('Discarding a message with an invalid payload');
      await this.queue.delete(message.receiptHandle);
      return;
    }

    const execution = new AbortController();
    const limit = setTimeout(() => {
      execution.abort();
    }, VIDEO_JOB_MAX_EXECUTION_MS);
    let renewal: Promise<void> = Promise.resolve();
    const heartbeat = setInterval(() => {
      renewal = this.renewVisibility(message.receiptHandle);
    }, VIDEO_JOB_HEARTBEAT_MS);

    let failure: { error: unknown } | null = null;
    try {
      await this.processor.process(
        message.videoId,
        AbortSignal.any([execution.signal, this.shutdown.signal]),
      );
    } catch (error) {
      failure = { error };
    } finally {
      clearTimeout(limit);
      clearInterval(heartbeat);
      // A late renewal would overwrite the backoff chosen below.
      await renewal;
    }

    if (failure) {
      await this.scheduleRetry(message, failure.error);
      return;
    }
    await this.queue.delete(message.receiptHandle);
  }

  private async renewVisibility(receiptHandle: string): Promise<void> {
    try {
      await this.queue.changeVisibility(
        receiptHandle,
        VIDEO_JOB_VISIBILITY_SECONDS,
      );
    } catch (error) {
      this.logger.error(`Heartbeat failed: ${errorMessage(error)}`);
    }
  }

  private async scheduleRetry(
    message: VideoProcessingMessage,
    error: unknown,
  ): Promise<void> {
    const delaySeconds = this.shutdown.signal.aborted
      ? 0
      : this.backoffSeconds(message.receiveCount);
    this.logger.warn(
      `Video ${message.videoId} failed on attempt ${message.receiveCount}, retrying in ${delaySeconds}s: ${errorMessage(error)}`,
    );
    try {
      await this.queue.changeVisibility(message.receiptHandle, delaySeconds);
    } catch (visibilityError) {
      // The message still reappears when the current visibility expires.
      this.logger.error(
        `Could not schedule the retry: ${errorMessage(visibilityError)}`,
      );
    }
  }

  private backoffSeconds(receiveCount: number): number {
    const index = Math.min(
      Math.max(receiveCount, 1) - 1,
      VIDEO_JOB_BACKOFF_SECONDS.length - 1,
    );
    return VIDEO_JOB_BACKOFF_SECONDS[index];
  }
}
