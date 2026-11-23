import {
  BeforeApplicationShutdown,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { QUEUE_LONG_POLL_SECONDS } from '../queue/queue.constants';
import { VideoProcessingQueueService } from '../queue/video-processing-queue.service';
import { VideoStatus } from '../videos/entities/video-status.enum';
import { Video } from '../videos/entities/video.entity';
import { VIDEO_FAILURE_CODES } from '../videos/videos.constants';
import { runPollingLoop } from './polling-loop';
import { EXHAUSTED_RETENTION } from './video-worker.constants';

@Injectable()
export class VideoDlqConsumer
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(VideoDlqConsumer.name);
  private readonly shutdown = new AbortController();
  private loop: Promise<void> | null = null;

  constructor(
    @InjectRepository(Video)
    private readonly videos: Repository<Video>,
    private readonly queue: VideoProcessingQueueService,
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

  async pollOnce(
    waitTimeSeconds: number = QUEUE_LONG_POLL_SECONDS,
  ): Promise<boolean> {
    const message = await this.queue.receiveDeadLetter(
      waitTimeSeconds,
      this.shutdown.signal,
    );
    if (!message) {
      return false;
    }

    if (message.videoId) {
      await this.markExhausted(message.videoId);
    } else {
      this.logger.warn('Discarding a dead letter with an invalid payload');
    }
    await this.queue.deleteDeadLetter(message.receiptHandle);
    return true;
  }

  private async markExhausted(videoId: string): Promise<void> {
    const { affected } = await this.videos.update(
      { id: videoId, status: VideoStatus.PROCESSING },
      {
        status: VideoStatus.FAILED,
        failure_code: VIDEO_FAILURE_CODES.PROCESSING_EXHAUSTED,
        storage_purge_after: () => `now() + interval '${EXHAUSTED_RETENTION}'`,
      },
    );
    if (affected) {
      this.logger.error(`Video ${videoId} exhausted its processing attempts`);
    }
  }
}
