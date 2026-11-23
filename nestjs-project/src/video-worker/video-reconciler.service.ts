import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { VideoProcessingQueueService } from '../queue/video-processing-queue.service';
import { VideoStatus } from '../videos/entities/video-status.enum';
import { Video } from '../videos/entities/video.entity';
import { errorMessage } from './polling-loop';
import {
  RECONCILER_BATCH_SIZE,
  RECONCILER_LOST_JOB_AFTER,
  RECONCILER_NULL_JOB_GRACE,
} from './video-worker.constants';

@Injectable()
export class VideoReconcilerService {
  private readonly logger = new Logger(VideoReconcilerService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly queue: VideoProcessingQueueService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, {
    name: 'video-reconciler',
    waitForCompletion: true,
  })
  async handleSchedule(): Promise<void> {
    try {
      const resent = await this.reconcile();
      if (resent > 0) {
        this.logger.log(`Re-enqueued ${resent} video(s)`);
      }
    } catch (error) {
      this.logger.error(`Reconciliation failed: ${errorMessage(error)}`);
    }
  }

  async reconcile(): Promise<number> {
    let resent = 0;
    while (resent < RECONCILER_BATCH_SIZE && (await this.resendNext())) {
      resent += 1;
    }
    return resent;
  }

  // One transaction per video: a queue failure keeps what was already sent,
  // and the row lock stops another replica from sending the same video.
  private resendNext(): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      const video = await manager
        .getRepository(Video)
        .createQueryBuilder('video')
        .select('video.id')
        .where('video.status = :status', { status: VideoStatus.PROCESSING })
        .andWhere(
          `(
            (video.job_enqueued_at IS NULL
              AND video.updated_at < now() - CAST(:nullJobGrace AS interval))
            OR video.job_enqueued_at < now() - CAST(:lostJobAfter AS interval)
          )`,
          {
            nullJobGrace: RECONCILER_NULL_JOB_GRACE,
            lostJobAfter: RECONCILER_LOST_JOB_AFTER,
          },
        )
        .orderBy('video.updated_at', 'ASC')
        .limit(1)
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .getOne();
      if (!video) {
        return false;
      }

      await this.queue.enqueue(video.id);
      await manager.update(
        Video,
        { id: video.id },
        { job_enqueued_at: () => 'now()' },
      );
      return true;
    });
  }
}
