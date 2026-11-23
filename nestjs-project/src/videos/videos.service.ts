import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { videoSourceKey } from '../storage/storage-keys';
import {
  type PublicGetObjectOptions,
  StorageService,
} from '../storage/storage.service';
import type { VideoAccessUrlResponseDto } from './dto/video-access-url-response.dto';
import type { VideoResponseDto } from './dto/video-response.dto';
import { VideoStatus } from './entities/video-status.enum';
import { Video } from './entities/video.entity';
import { buildAttachmentDisposition } from './video-download-filename.util';
import { isValidVideoSlug } from './video-slug.util';
import {
  VideoNotFoundException,
  VideoNotReadyException,
} from './video.exceptions';
import {
  DOWNLOAD_URL_TTL_SECONDS,
  PLAYBACK_URL_MAX_TTL_SECONDS,
  PLAYBACK_URL_MIN_TTL_SECONDS,
  THUMBNAIL_URL_TTL_SECONDS,
} from './videos.constants';

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videos: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storage: StorageService,
  ) {}

  async getVideo(userId: string, slug: string): Promise<VideoResponseDto> {
    const video = await this.findOwnedVideo(userId, slug);
    const thumbnailUrl =
      video.status === VideoStatus.READY && video.thumbnail_key
        ? await this.storage.signPublicGetObject(video.thumbnail_key, {
            expiresInSeconds: THUMBNAIL_URL_TTL_SECONDS,
          })
        : null;

    return {
      id: video.id,
      slug: video.slug,
      status: video.status,
      originalFilename: video.original_filename,
      sizeBytes: video.size_bytes,
      contentType: video.content_type,
      durationSeconds: video.duration_seconds,
      width: video.width,
      height: video.height,
      container: video.container,
      videoCodec: video.video_codec,
      audioCodec: video.audio_codec,
      thumbnailUrl,
      failureCode: video.failure_code,
      createdAt: video.created_at.toISOString(),
      updatedAt: video.updated_at.toISOString(),
    };
  }

  async getPlayback(
    userId: string,
    slug: string,
  ): Promise<VideoAccessUrlResponseDto> {
    const video = await this.findReadyVideo(userId, slug);
    return this.signSource(video, {
      expiresInSeconds: this.playbackTtlSeconds(video.duration_seconds ?? 0),
      responseContentType: video.content_type ?? undefined,
      responseContentDisposition: 'inline',
    });
  }

  async getDownload(
    userId: string,
    slug: string,
  ): Promise<VideoAccessUrlResponseDto> {
    const video = await this.findReadyVideo(userId, slug);
    return this.signSource(video, {
      expiresInSeconds: DOWNLOAD_URL_TTL_SECONDS,
      responseContentType: video.content_type ?? undefined,
      responseContentDisposition: buildAttachmentDisposition(
        video.original_filename,
      ),
    });
  }

  private playbackTtlSeconds(durationSeconds: number): number {
    return Math.min(
      PLAYBACK_URL_MAX_TTL_SECONDS,
      Math.max(PLAYBACK_URL_MIN_TTL_SECONDS, Math.ceil(2 * durationSeconds)),
    );
  }

  private async signSource(
    video: Video,
    options: PublicGetObjectOptions,
  ): Promise<VideoAccessUrlResponseDto> {
    // Taken before signing, so the URL is never shorter-lived than reported.
    const expiresAt = new Date(Date.now() + options.expiresInSeconds * 1000);
    const url = await this.storage.signPublicGetObject(
      videoSourceKey(video.id),
      options,
    );
    return { url, expiresAt: expiresAt.toISOString() };
  }

  private async findReadyVideo(userId: string, slug: string): Promise<Video> {
    const video = await this.findOwnedVideo(userId, slug);
    if (video.status !== VideoStatus.READY) {
      throw new VideoNotReadyException();
    }
    return video;
  }

  private async findOwnedVideo(userId: string, slug: string): Promise<Video> {
    if (!isValidVideoSlug(slug)) {
      throw new VideoNotFoundException();
    }
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new VideoNotFoundException();
    }
    const video = await this.videos.findOne({
      where: { slug, channel_id: channel.id },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    return video;
  }
}
