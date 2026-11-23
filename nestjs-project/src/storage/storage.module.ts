import { Module } from '@nestjs/common';
import {
  s3InternalClientProvider,
  s3PresignClientProvider,
} from './storage.providers';
import { StorageService } from './storage.service';

@Module({
  providers: [
    s3InternalClientProvider,
    s3PresignClientProvider,
    StorageService,
  ],
  exports: [StorageService],
})
export class StorageModule {}
