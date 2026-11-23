import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../entities/video-status.enum';

export class VideoResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'aZ3kP9xQ1bC' })
  slug: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.READY })
  status: VideoStatus;

  @ApiProperty({ example: 'my-video.mp4' })
  originalFilename: string;

  @ApiProperty({ type: Number, nullable: true, example: 104857600 })
  sizeBytes: number | null;

  @ApiProperty({ type: String, nullable: true, example: 'video/mp4' })
  contentType: string | null;

  @ApiProperty({ type: Number, nullable: true, example: 125.48 })
  durationSeconds: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 1920 })
  width: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 1080 })
  height: number | null;

  @ApiProperty({ type: String, nullable: true, example: 'mp4' })
  container: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'h264' })
  videoCodec: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'aac' })
  audioCodec: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Presigned URL valid for 1 hour, present only when ready',
  })
  thumbnailUrl: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'UNSUPPORTED_FORMAT',
  })
  failureCode: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt: string;
}
