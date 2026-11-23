import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { videoSourceKey, videoThumbnailKey } from '../storage/storage-keys';
import { StorageService } from '../storage/storage.service';
import { VideoStatus } from '../videos/entities/video-status.enum';
import { Video } from '../videos/entities/video.entity';
import { VIDEO_FAILURE_CODES } from '../videos/videos.constants';
import { FfmpegService, type MediaProbe } from './ffmpeg.service';
import { MediaUnreadableError } from './media.errors';
import {
  resolveContentType,
  type SupportedContentType,
} from './media-allowlist';
import { VIDEO_SOURCE_URL_SECONDS } from './video-worker.constants';

export type VideoProcessingOutcome = 'ready' | 'failed' | 'skipped';

const THUMBNAIL_CONTENT_TYPE = 'image/jpeg';

@Injectable()
export class VideoProcessorService {
  private readonly logger = new Logger(VideoProcessorService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videos: Repository<Video>,
    private readonly storage: StorageService,
    private readonly ffmpeg: FfmpegService,
  ) {}

  /**
   * Resolves when the message can be removed from the queue. Any rejection is
   * transient: the message stays in the queue and is retried.
   */
  async process(
    videoId: string,
    signal?: AbortSignal,
  ): Promise<VideoProcessingOutcome> {
    const video = await this.videos.findOne({
      where: { id: videoId },
      select: { id: true, status: true },
    });
    if (video?.status !== VideoStatus.PROCESSING) {
      return 'skipped';
    }

    try {
      const url = await this.storage.signInternalGetObject(
        videoSourceKey(videoId),
        VIDEO_SOURCE_URL_SECONDS,
      );
      const media = await this.ffmpeg.probe(url, signal);
      const contentType = resolveContentType(media);
      if (!contentType) {
        return await this.markUnsupported(videoId);
      }

      const thumbnail = await this.ffmpeg.extractThumbnail(
        url,
        media.durationSeconds,
        signal,
      );
      const thumbnailKey = videoThumbnailKey(videoId);
      await this.storage.putObject(
        thumbnailKey,
        thumbnail,
        THUMBNAIL_CONTENT_TYPE,
      );
      return await this.markReady(videoId, media, contentType, thumbnailKey);
    } catch (error) {
      if (error instanceof MediaUnreadableError) {
        return this.markUnsupported(videoId);
      }
      throw error;
    }
  }

  private async markReady(
    videoId: string,
    media: MediaProbe,
    contentType: SupportedContentType,
    thumbnailKey: string,
  ): Promise<VideoProcessingOutcome> {
    const { affected } = await this.videos.update(
      { id: videoId, status: VideoStatus.PROCESSING },
      {
        status: VideoStatus.READY,
        content_type: contentType,
        duration_seconds: media.durationSeconds,
        width: media.width,
        height: media.height,
        container: media.container,
        video_codec: media.videoCodec,
        audio_codec: media.audioCodec,
        thumbnail_key: thumbnailKey,
      },
    );
    return affected ? 'ready' : 'skipped';
  }

  private async markUnsupported(
    videoId: string,
  ): Promise<VideoProcessingOutcome> {
    const { affected } = await this.videos.update(
      { id: videoId, status: VideoStatus.PROCESSING },
      {
        status: VideoStatus.FAILED,
        failure_code: VIDEO_FAILURE_CODES.UNSUPPORTED_FORMAT,
        storage_purge_after: () => 'now()',
      },
    );
    if (!affected) {
      return 'skipped';
    }
    this.logger.warn(`Video ${videoId} has an unsupported format`);
    return 'failed';
  }
}
