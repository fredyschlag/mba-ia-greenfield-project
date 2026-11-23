import { ApiProperty } from '@nestjs/swagger';

export class SignedPartDto {
  @ApiProperty({ example: 1 })
  partNumber: number;

  @ApiProperty({ format: 'uri' })
  url: string;

  @ApiProperty({ example: 16777216 })
  contentLength: number;
}

export class SignPartsResponseDto {
  @ApiProperty({ type: [SignedPartDto] })
  parts: SignedPartDto[];

  @ApiProperty({ format: 'date-time' })
  expiresAt: string;
}

export class UploadedPartDto {
  @ApiProperty({ example: 1 })
  partNumber: number;

  @ApiProperty({ example: 16777216 })
  sizeBytes: number;

  @ApiProperty({ example: '"5d41402abc4b2a76b9719d911017c592"' })
  etag: string;
}

export class UploadedPartsResponseDto {
  @ApiProperty({ example: 16777216 })
  partSizeBytes: number;

  @ApiProperty({ example: 640 })
  partCount: number;

  @ApiProperty({ format: 'date-time' })
  uploadExpiresAt: string;

  @ApiProperty({ type: [UploadedPartDto] })
  parts: UploadedPartDto[];
}
