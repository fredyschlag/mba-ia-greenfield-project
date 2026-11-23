import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../entities/video-status.enum';

export class CompleteUploadResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'aZ3kP9xQ1bC' })
  slug: string;

  @ApiProperty({
    enum: [VideoStatus.PROCESSING, VideoStatus.READY],
    example: VideoStatus.PROCESSING,
  })
  status: VideoStatus;
}
