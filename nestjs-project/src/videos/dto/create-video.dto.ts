import {
  IsInt,
  IsNotEmpty,
  IsPositive,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateVideoDto {
  /** Original file name, kept only as metadata. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  filename: string;

  /** Exact file size in bytes. */
  @IsInt()
  @IsPositive()
  sizeBytes: number;
}
