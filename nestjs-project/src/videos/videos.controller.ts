import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiErrorResponse } from '../common/openapi/api-error-response.decorator';
import { CompleteUploadResponseDto } from './dto/complete-upload-response.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { SignPartsDto } from './dto/sign-parts.dto';
import {
  SignPartsResponseDto,
  UploadedPartsResponseDto,
} from './dto/upload-parts-response.dto';
import { VideoAccessUrlResponseDto } from './dto/video-access-url-response.dto';
import { VideoResponseDto } from './dto/video-response.dto';
import { VideoUploadResponseDto } from './dto/video-upload-response.dto';
import { VIDEO_THROTTLES } from './video-throttle.constants';
import { VideoUploadsService } from './video-uploads.service';
import { VideosService } from './videos.service';

const UNAUTHORIZED = 'Missing or invalid access token';
const VIDEO_NOT_FOUND = 'Video not found or owned by another channel';
const UPLOAD_EXPIRED = 'Upload session expired';
const TOO_MANY_REQUESTS = 'Rate limit exceeded for this user and route';
const VIDEO_NOT_READY = 'Video is not ready';

@ApiTags('videos')
@ApiBearerAuth('access-token')
@Controller('videos')
export class VideosController {
  constructor(
    private readonly videoUploadsService: VideoUploadsService,
    private readonly videosService: VideosService,
  ) {}

  @Post()
  @Throttle(VIDEO_THROTTLES.CREATE)
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      'Creates a draft video in the channel of the user and opens a multipart upload.',
  })
  @ApiResponse({
    status: 201,
    description: 'Draft created and upload started',
    type: VideoUploadResponseDto,
  })
  @ApiErrorResponse(400, 'Validation failed')
  @ApiErrorResponse(401, UNAUTHORIZED)
  @ApiErrorResponse(404, 'CHANNEL_NOT_FOUND: the user has no channel')
  @ApiErrorResponse(
    409,
    'ACTIVE_UPLOAD_LIMIT_REACHED: the channel already has 3 active uploads',
  )
  @ApiErrorResponse(413, 'VIDEO_TOO_LARGE: size above the upload limit')
  @ApiErrorResponse(429, TOO_MANY_REQUESTS)
  async create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<VideoUploadResponseDto> {
    return this.videoUploadsService.startUpload(user.sub, dto);
  }

  @Post(':id/upload/part-urls')
  @Throttle(VIDEO_THROTTLES.SIGN_PARTS)
  @ApiOperation({
    summary: 'Sign upload part URLs',
    description:
      'Returns presigned URLs, valid for 1 hour, to upload up to 50 parts directly to the storage.',
  })
  @ApiResponse({
    status: 201,
    description: 'Part URLs signed',
    type: SignPartsResponseDto,
  })
  @ApiErrorResponse(400, 'Validation failed or INVALID_PART_NUMBER')
  @ApiErrorResponse(401, UNAUTHORIZED)
  @ApiErrorResponse(404, VIDEO_NOT_FOUND)
  @ApiErrorResponse(409, 'UPLOAD_NOT_ACTIVE: video is not a draft')
  @ApiErrorResponse(410, UPLOAD_EXPIRED)
  @ApiErrorResponse(429, TOO_MANY_REQUESTS)
  async signParts(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SignPartsDto,
  ): Promise<SignPartsResponseDto> {
    return this.videoUploadsService.signParts(user.sub, id, dto);
  }

  @Get(':id/upload/parts')
  @Throttle(VIDEO_THROTTLES.LIST_PARTS)
  @ApiOperation({
    summary: 'List uploaded parts',
    description:
      'Returns the parts already stored, so an interrupted upload can resume.',
  })
  @ApiResponse({
    status: 200,
    description: 'Uploaded parts',
    type: UploadedPartsResponseDto,
  })
  @ApiErrorResponse(400, 'Malformed video id')
  @ApiErrorResponse(401, UNAUTHORIZED)
  @ApiErrorResponse(404, VIDEO_NOT_FOUND)
  @ApiErrorResponse(409, 'UPLOAD_NOT_ACTIVE: video is not a draft')
  @ApiErrorResponse(410, UPLOAD_EXPIRED)
  @ApiErrorResponse(429, TOO_MANY_REQUESTS)
  async listUploadedParts(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<UploadedPartsResponseDto> {
    return this.videoUploadsService.listUploadedParts(user.sub, id);
  }

  @Post(':id/upload/complete')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle(VIDEO_THROTTLES.COMPLETE)
  @ApiOperation({
    summary: 'Complete a video upload',
    description:
      'Validates the parts, completes the multipart upload and queues the video for processing. Retrying is idempotent.',
  })
  @ApiResponse({
    status: 202,
    description: 'Upload completed and video accepted for processing',
    type: CompleteUploadResponseDto,
  })
  @ApiErrorResponse(400, 'Validation failed')
  @ApiErrorResponse(401, UNAUTHORIZED)
  @ApiErrorResponse(404, VIDEO_NOT_FOUND)
  @ApiErrorResponse(
    409,
    'UPLOAD_INCOMPLETE: stored parts differ, or UPLOAD_NOT_ACTIVE: video failed',
  )
  @ApiErrorResponse(410, UPLOAD_EXPIRED)
  @ApiErrorResponse(
    422,
    'VIDEO_SIZE_MISMATCH: final size differs from the declared size',
  )
  @ApiErrorResponse(429, TOO_MANY_REQUESTS)
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<CompleteUploadResponseDto> {
    return this.videoUploadsService.completeUpload(user.sub, id, dto);
  }

  @Get(':slug')
  @Throttle(VIDEO_THROTTLES.GET)
  @ApiOperation({
    summary: 'Get a video',
    description:
      'Returns status and metadata to the owner. The thumbnail URL is present only when the video is ready.',
  })
  @ApiResponse({
    status: 200,
    description: 'Video found',
    type: VideoResponseDto,
  })
  @ApiErrorResponse(401, UNAUTHORIZED)
  @ApiErrorResponse(404, VIDEO_NOT_FOUND)
  @ApiErrorResponse(429, TOO_MANY_REQUESTS)
  async getVideo(
    @CurrentUser() user: JwtPayload,
    @Param('slug') slug: string,
  ): Promise<VideoResponseDto> {
    return this.videosService.getVideo(user.sub, slug);
  }

  @Get(':slug/playback')
  @Throttle(VIDEO_THROTTLES.PLAYBACK)
  @ApiOperation({
    summary: 'Get a playback URL',
    description:
      'Returns a presigned URL that supports Range requests, valid for twice the duration, between 1 hour and 7 days.',
  })
  @ApiResponse({
    status: 200,
    description: 'Playback URL signed',
    type: VideoAccessUrlResponseDto,
  })
  @ApiErrorResponse(401, UNAUTHORIZED)
  @ApiErrorResponse(404, VIDEO_NOT_FOUND)
  @ApiErrorResponse(409, `VIDEO_NOT_READY: ${VIDEO_NOT_READY}`)
  @ApiErrorResponse(429, TOO_MANY_REQUESTS)
  async getPlayback(
    @CurrentUser() user: JwtPayload,
    @Param('slug') slug: string,
  ): Promise<VideoAccessUrlResponseDto> {
    return this.videosService.getPlayback(user.sub, slug);
  }

  @Get(':slug/download')
  @Throttle(VIDEO_THROTTLES.DOWNLOAD)
  @ApiOperation({
    summary: 'Get a download URL',
    description:
      'Returns a presigned URL, valid for 6 hours, that downloads the file as an attachment.',
  })
  @ApiResponse({
    status: 200,
    description: 'Download URL signed',
    type: VideoAccessUrlResponseDto,
  })
  @ApiErrorResponse(401, UNAUTHORIZED)
  @ApiErrorResponse(404, VIDEO_NOT_FOUND)
  @ApiErrorResponse(409, `VIDEO_NOT_READY: ${VIDEO_NOT_READY}`)
  @ApiErrorResponse(429, TOO_MANY_REQUESTS)
  async getDownload(
    @CurrentUser() user: JwtPayload,
    @Param('slug') slug: string,
  ): Promise<VideoAccessUrlResponseDto> {
    return this.videosService.getDownload(user.sub, slug);
  }
}
