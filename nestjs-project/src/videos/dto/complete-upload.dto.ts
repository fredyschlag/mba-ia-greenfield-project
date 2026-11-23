import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsPositive,
  IsString,
  ValidateNested,
} from 'class-validator';
import { MAX_VIDEO_PARTS } from '../videos.constants';

export class CompleteUploadPartDto {
  /** Part number returned when the URL was signed. */
  @IsInt()
  @IsPositive()
  partNumber: number;

  /** ETag returned by the storage for this part. */
  @IsString()
  @IsNotEmpty()
  etag: string;
}

export class CompleteUploadDto {
  /** Every uploaded part of the file. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_VIDEO_PARTS)
  @ArrayUnique((part?: CompleteUploadPartDto) => part?.partNumber)
  @ValidateNested({ each: true })
  @Type(() => CompleteUploadPartDto)
  parts: CompleteUploadPartDto[];
}
