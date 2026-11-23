import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsInt,
  IsPositive,
} from 'class-validator';
import { MAX_PARTS_PER_SIGN_BATCH } from '../videos.constants';

export class SignPartsDto {
  /** Part numbers to sign, from 1 to the upload part count. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PARTS_PER_SIGN_BATCH)
  @ArrayUnique()
  @IsInt({ each: true })
  @IsPositive({ each: true })
  partNumbers: number[];
}
