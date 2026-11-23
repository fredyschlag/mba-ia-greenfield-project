import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource, type EntityManager } from 'typeorm';
import { videoSourceKey, videoThumbnailKey } from '../storage/storage-keys';
import { StorageService } from '../storage/storage.service';
import { VideoStatus } from '../videos/entities/video-status.enum';
import { Video } from '../videos/entities/video.entity';
import { errorMessage } from './polling-loop';
import { CLEANUP_BATCH_SIZE } from './video-worker.constants';

type LockNext = (
  manager: EntityManager,
  excludedIds: string[],
) => Promise<Video | null>;
type CleanupAction = (manager: EntityManager, video: Video) => Promise<void>;

@Injectable()
export class VideoCleanupService {
  private readonly logger = new Logger(VideoCleanupService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly storage: StorageService,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES, {
    name: 'video-cleanup',
    waitForCompletion: true,
  })
  async handleSchedule(): Promise<void> {
    await this.runSweep('Expired draft sweep', () => this.sweepExpiredDrafts());
    await this.runSweep('Failed video purge', () => this.purgeFailedVideos());
  }

  sweepExpiredDrafts(): Promise<number> {
    return this.forEachLocked(
      (manager, excludedIds) => this.lockNextExpiredDraft(manager, excludedIds),
      (manager, video) => this.removeDraft(manager, video),
    );
  }

  purgeFailedVideos(): Promise<number> {
    return this.forEachLocked(
      (manager, excludedIds) => this.lockNextPurgeable(manager, excludedIds),
      (manager, video) => this.purgeObjects(manager, video),
    );
  }

  private async runSweep(
    name: string,
    sweep: () => Promise<number>,
  ): Promise<void> {
    try {
      const count = await sweep();
      if (count > 0) {
        this.logger.log(`${name} handled ${count} video(s)`);
      }
    } catch (error) {
      this.logger.error(`${name} failed: ${errorMessage(error)}`);
    }
  }

  // One transaction per video keeps the row locked during the storage calls.
  // A video that fails is excluded for this run, so the batch moves on.
  private async forEachLocked(
    lockNext: LockNext,
    action: CleanupAction,
  ): Promise<number> {
    const failedIds: string[] = [];
    let handled = 0;

    while (handled + failedIds.length < CLEANUP_BATCH_SIZE) {
      const current: { id?: string } = {};
      try {
        const found = await this.dataSource.transaction(async (manager) => {
          const video = await lockNext(manager, failedIds);
          if (!video) {
            return false;
          }
          current.id = video.id;
          await action(manager, video);
          return true;
        });
        if (!found) {
          break;
        }
        handled += 1;
      } catch (error) {
        if (!current.id) {
          throw error;
        }
        this.logger.error(
          `Cleanup failed for video ${current.id}: ${errorMessage(error)}`,
        );
        failedIds.push(current.id);
      }
    }
    return handled;
  }

  private lockNextExpiredDraft(
    manager: EntityManager,
    excludedIds: string[],
  ): Promise<Video | null> {
    const query = manager
      .getRepository(Video)
      .createQueryBuilder('video')
      .select(['video.id', 'video.upload_id'])
      .where('video.status = :status', { status: VideoStatus.DRAFT })
      .andWhere('video.upload_expires_at <= now()');
    if (excludedIds.length > 0) {
      query.andWhere('video.id NOT IN (:...excludedIds)', { excludedIds });
    }
    return query
      .orderBy('video.upload_expires_at', 'ASC')
      .limit(1)
      .setLock('pessimistic_write')
      .setOnLocked('skip_locked')
      .getOne();
  }

  private lockNextPurgeable(
    manager: EntityManager,
    excludedIds: string[],
  ): Promise<Video | null> {
    const query = manager
      .getRepository(Video)
      .createQueryBuilder('video')
      .select('video.id')
      .where('video.status = :status', { status: VideoStatus.FAILED })
      .andWhere('video.storage_purged_at IS NULL')
      .andWhere('video.storage_purge_after <= now()');
    if (excludedIds.length > 0) {
      query.andWhere('video.id NOT IN (:...excludedIds)', { excludedIds });
    }
    return query
      .orderBy('video.storage_purge_after', 'ASC')
      .limit(1)
      .setLock('pessimistic_write')
      .setOnLocked('skip_locked')
      .getOne();
  }

  private async removeDraft(
    manager: EntityManager,
    video: Video,
  ): Promise<void> {
    const key = videoSourceKey(video.id);
    if (video.upload_id) {
      await this.storage.abortMultipartUpload(key, video.upload_id);
    }
    await this.storage.deleteObject(key);
    await manager.delete(Video, { id: video.id });
  }

  private async purgeObjects(
    manager: EntityManager,
    video: Video,
  ): Promise<void> {
    await this.storage.deleteObject(videoSourceKey(video.id));
    await this.storage.deleteObject(videoThumbnailKey(video.id));
    await manager.update(
      Video,
      { id: video.id },
      { storage_purged_at: () => 'now()' },
    );
  }
}
