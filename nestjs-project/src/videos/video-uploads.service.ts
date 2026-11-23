import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  type EntityManager,
  MoreThan,
  QueryFailedError,
  Repository,
} from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import videoConfig from '../config/video.config';
import { VideoProcessingQueueService } from '../queue/video-processing-queue.service';
import { videoSourceKey } from '../storage/storage-keys';
import { UPLOAD_PART_URL_TTL_SECONDS } from '../storage/storage.constants';
import { StorageService, type StoredPart } from '../storage/storage.service';
import type { CompleteUploadResponseDto } from './dto/complete-upload-response.dto';
import type {
  CompleteUploadDto,
  CompleteUploadPartDto,
} from './dto/complete-upload.dto';
import type { CreateVideoDto } from './dto/create-video.dto';
import type { SignPartsDto } from './dto/sign-parts.dto';
import type {
  SignPartsResponseDto,
  UploadedPartsResponseDto,
} from './dto/upload-parts-response.dto';
import type { VideoUploadResponseDto } from './dto/video-upload-response.dto';
import { VideoStatus } from './entities/video-status.enum';
import { Video } from './entities/video.entity';
import { generateVideoSlug } from './video-slug.util';
import {
  ActiveUploadLimitReachedException,
  ChannelNotFoundException,
  InvalidPartNumberException,
  UploadExpiredException,
  UploadIncompleteException,
  UploadNotActiveException,
  VideoNotFoundException,
  VideoSizeMismatchException,
  VideoTooLargeException,
} from './video.exceptions';
import {
  MAX_ACTIVE_UPLOADS_PER_CHANNEL,
  UPLOAD_SESSION_MS,
  VIDEO_FAILURE_CODES,
  VIDEO_PART_SIZE_BYTES,
  VIDEO_SLUG_MAX_ATTEMPTS,
} from './videos.constants';

const PG_UNIQUE_VIOLATION = '23505';

function isSlugCollision(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) return false;
  const { code, detail } = error.driverError as {
    code?: string;
    detail?: string;
  };
  return code === PG_UNIQUE_VIOLATION && Boolean(detail?.includes('(slug)'));
}

function normalizeEtag(etag: string): string {
  return etag.replaceAll('"', '');
}

@Injectable()
export class VideoUploadsService {
  private readonly logger = new Logger(VideoUploadsService.name);

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storage: StorageService,
    private readonly queue: VideoProcessingQueueService,
    @Inject(videoConfig.KEY)
    private readonly config: ConfigType<typeof videoConfig>,
  ) {}

  async startUpload(
    userId: string,
    dto: CreateVideoDto,
  ): Promise<VideoUploadResponseDto> {
    if (dto.sizeBytes > this.config.maxUploadBytes) {
      throw new VideoTooLargeException();
    }

    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) throw new ChannelNotFoundException();

    const activeUploads = await this.countActiveUploads(
      this.videoRepository.manager,
      channel.id,
    );
    if (activeUploads >= MAX_ACTIVE_UPLOADS_PER_CHANNEL) {
      throw new ActiveUploadLimitReachedException();
    }

    const videoId = randomUUID();
    const key = videoSourceKey(videoId);
    const uploadId = await this.storage.createMultipartUpload(key);

    try {
      return await this.dataSource.transaction((manager) =>
        this.insertDraft(manager, userId, videoId, uploadId, dto),
      );
    } catch (error) {
      await this.abortAfterFailure(key, uploadId);
      throw error;
    }
  }

  async signParts(
    userId: string,
    videoId: string,
    dto: SignPartsDto,
  ): Promise<SignPartsResponseDto> {
    const video = await this.loadActiveDraft(userId, videoId);
    if (dto.partNumbers.some((number) => number > video.part_count)) {
      throw new InvalidPartNumberException();
    }

    const expiresAt = new Date(Date.now() + UPLOAD_PART_URL_TTL_SECONDS * 1000);
    const key = videoSourceKey(video.id);
    const parts = await Promise.all(
      dto.partNumbers.map(async (partNumber) => {
        const contentLength = this.partContentLength(video, partNumber);
        const url = await this.storage.signUploadPart(
          key,
          video.upload_id!,
          partNumber,
          contentLength,
        );
        return { partNumber, url, contentLength };
      }),
    );

    return { parts, expiresAt: expiresAt.toISOString() };
  }

  async listUploadedParts(
    userId: string,
    videoId: string,
  ): Promise<UploadedPartsResponseDto> {
    const video = await this.loadActiveDraft(userId, videoId);
    const parts = await this.storage.listAllParts(
      videoSourceKey(video.id),
      video.upload_id!,
    );
    if (!parts) throw new UploadNotActiveException();

    return {
      partSizeBytes: video.part_size_bytes,
      partCount: video.part_count,
      uploadExpiresAt: video.upload_expires_at!.toISOString(),
      parts,
    };
  }

  async completeUpload(
    userId: string,
    videoId: string,
    dto: CompleteUploadDto,
  ): Promise<CompleteUploadResponseDto> {
    const video = await this.findOwnedWithUploadId(userId, videoId);
    if (!video) throw new VideoNotFoundException();

    if (
      video.status === VideoStatus.PROCESSING ||
      video.status === VideoStatus.READY
    ) {
      return { id: video.id, slug: video.slug, status: video.status };
    }
    if (video.status !== VideoStatus.DRAFT || !video.upload_id) {
      throw new UploadNotActiveException();
    }
    this.assertSessionNotExpired(video);

    const key = videoSourceKey(video.id);
    const storedParts = await this.storage.listAllParts(key, video.upload_id);
    if (storedParts) {
      this.assertPartsMatch(video, storedParts, dto.parts);
      await this.storage.completeMultipartUpload(
        key,
        video.upload_id,
        storedParts,
      );
    }

    // A missing multipart means a previous attempt may have completed it.
    const stored = await this.storage.headObject(key);
    if (!stored) throw new UploadNotActiveException();
    if (stored.contentLength !== video.declared_size_bytes) {
      await this.failOnSizeMismatch(video, key, stored.contentLength);
      throw new VideoSizeMismatchException();
    }

    return this.startProcessing(video, stored.contentLength);
  }

  private assertPartsMatch(
    video: Video,
    storedParts: StoredPart[],
    requestedParts: CompleteUploadPartDto[],
  ): void {
    const storedSize = storedParts.reduce(
      (total, part) => total + part.sizeBytes,
      0,
    );
    const requested = new Map(
      requestedParts.map((part) => [part.partNumber, normalizeEtag(part.etag)]),
    );
    const matches =
      storedParts.length === video.part_count &&
      requestedParts.length === video.part_count &&
      storedSize === video.declared_size_bytes &&
      storedParts.every(
        (part) => requested.get(part.partNumber) === normalizeEtag(part.etag),
      );

    if (!matches) throw new UploadIncompleteException();
  }

  private async failOnSizeMismatch(
    video: Video,
    key: string,
    actualSize: number,
  ): Promise<void> {
    await this.storage.deleteObject(key);

    const now = new Date();
    await this.videoRepository.update(
      { id: video.id, status: VideoStatus.DRAFT },
      {
        status: VideoStatus.FAILED,
        failure_code: VIDEO_FAILURE_CODES.SIZE_MISMATCH,
        size_bytes: actualSize,
        upload_id: null,
        storage_purge_after: now,
        storage_purged_at: now,
      },
    );
  }

  private async startProcessing(
    video: Video,
    sizeBytes: number,
  ): Promise<CompleteUploadResponseDto> {
    const { affected } = await this.videoRepository.update(
      { id: video.id, status: VideoStatus.DRAFT },
      {
        status: VideoStatus.PROCESSING,
        size_bytes: sizeBytes,
        upload_id: null,
        job_enqueued_at: null,
      },
    );

    if (!affected) {
      // A concurrent attempt already moved the video out of draft.
      const current = await this.videoRepository.findOneBy({ id: video.id });
      if (!current) throw new VideoNotFoundException();
      if (current.status === VideoStatus.FAILED) {
        throw new UploadNotActiveException();
      }
      return { id: current.id, slug: current.slug, status: current.status };
    }

    await this.enqueueProcessing(video.id);
    return {
      id: video.id,
      slug: video.slug,
      status: VideoStatus.PROCESSING,
    };
  }

  private async enqueueProcessing(videoId: string): Promise<void> {
    try {
      await this.queue.enqueue(videoId);
      await this.videoRepository.update(
        { id: videoId, status: VideoStatus.PROCESSING },
        { job_enqueued_at: new Date() },
      );
    } catch (error) {
      // The status is committed; the reconciler resends while this stays null.
      this.logger.error(`Failed to enqueue video ${videoId}`, error);
    }
  }

  private async findOwnedWithUploadId(
    userId: string,
    videoId: string,
  ): Promise<Video | null> {
    return this.videoRepository
      .createQueryBuilder('video')
      .addSelect('video.upload_id')
      .innerJoin('video.channel', 'channel')
      .where('video.id = :videoId', { videoId })
      .andWhere('channel.user_id = :userId', { userId })
      .getOne();
  }

  private async loadActiveDraft(
    userId: string,
    videoId: string,
  ): Promise<Video> {
    const video = await this.findOwnedWithUploadId(userId, videoId);
    if (!video) throw new VideoNotFoundException();
    if (video.status !== VideoStatus.DRAFT || !video.upload_id) {
      throw new UploadNotActiveException();
    }
    this.assertSessionNotExpired(video);
    return video;
  }

  private assertSessionNotExpired(video: Video): void {
    if (
      !video.upload_expires_at ||
      video.upload_expires_at.getTime() <= Date.now()
    ) {
      throw new UploadExpiredException();
    }
  }

  private partContentLength(video: Video, partNumber: number): number {
    if (partNumber < video.part_count) return video.part_size_bytes;
    return (
      video.declared_size_bytes - video.part_size_bytes * (video.part_count - 1)
    );
  }

  private async insertDraft(
    manager: EntityManager,
    userId: string,
    videoId: string,
    uploadId: string,
    dto: CreateVideoDto,
  ): Promise<VideoUploadResponseDto> {
    const channel = await this.channelsService.lockByUserId(manager, userId);
    if (!channel) throw new ChannelNotFoundException();

    const activeUploads = await this.countActiveUploads(manager, channel.id);
    if (activeUploads >= MAX_ACTIVE_UPLOADS_PER_CHANNEL) {
      throw new ActiveUploadLimitReachedException();
    }

    const partCount = Math.ceil(dto.sizeBytes / VIDEO_PART_SIZE_BYTES);
    const uploadExpiresAt = new Date(Date.now() + UPLOAD_SESSION_MS);
    const slug = await this.insertWithUniqueSlug(manager, {
      id: videoId,
      channel_id: channel.id,
      status: VideoStatus.DRAFT,
      original_filename: dto.filename,
      declared_size_bytes: dto.sizeBytes,
      part_size_bytes: VIDEO_PART_SIZE_BYTES,
      part_count: partCount,
      upload_id: uploadId,
      upload_expires_at: uploadExpiresAt,
    });

    return {
      id: videoId,
      slug,
      status: VideoStatus.DRAFT,
      partSizeBytes: VIDEO_PART_SIZE_BYTES,
      partCount,
      uploadExpiresAt: uploadExpiresAt.toISOString(),
    };
  }

  private async insertWithUniqueSlug(
    manager: EntityManager,
    values: Partial<Video>,
  ): Promise<string> {
    for (let attempt = 1; ; attempt += 1) {
      const savepoint = `video_slug_attempt_${attempt}`;
      const slug = generateVideoSlug();

      await manager.query(`SAVEPOINT ${savepoint}`);
      try {
        await manager.insert(Video, { ...values, slug });
        await manager.query(`RELEASE SAVEPOINT ${savepoint}`);
        return slug;
      } catch (error) {
        await manager.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        if (!isSlugCollision(error) || attempt >= VIDEO_SLUG_MAX_ATTEMPTS) {
          throw error;
        }
      }
    }
  }

  private async countActiveUploads(
    manager: EntityManager,
    channelId: string,
  ): Promise<number> {
    return manager.count(Video, {
      where: {
        channel_id: channelId,
        status: VideoStatus.DRAFT,
        upload_expires_at: MoreThan(new Date()),
      },
    });
  }

  private async abortAfterFailure(
    key: string,
    uploadId: string,
  ): Promise<void> {
    try {
      await this.storage.abortMultipartUpload(key, uploadId);
    } catch (error) {
      // The stale-upload expiry removes it; keep the original error visible.
      this.logger.error(`Failed to abort multipart upload for ${key}`, error);
    }
  }
}
