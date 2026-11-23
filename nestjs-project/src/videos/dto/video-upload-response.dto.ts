import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../entities/video-status.enum';

export class VideoUploadResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'aZ3kP9xQ1bC' })
  slug: string;

  @ApiProperty({ enum: [VideoStatus.DRAFT], example: VideoStatus.DRAFT })
  status: VideoStatus;

  @ApiProperty({ example: 16777216 })
  partSizeBytes: number;

  @ApiProperty({ example: 640 })
  partCount: number;

  @ApiProperty({ format: 'date-time' })
  uploadExpiresAt: string;
}
