import { ApiProperty } from '@nestjs/swagger';

export class VideoAccessUrlResponseDto {
  @ApiProperty({ description: 'Presigned storage URL' })
  url: string;

  @ApiProperty({ format: 'date-time' })
  expiresAt: string;
}
