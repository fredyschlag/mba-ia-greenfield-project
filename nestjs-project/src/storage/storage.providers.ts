import { S3Client } from '@aws-sdk/client-s3';
import type { Provider } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { S3_INTERNAL_CLIENT, S3_PRESIGN_CLIENT } from './storage.constants';

export const s3InternalClientProvider: Provider = {
  provide: S3_INTERNAL_CLIENT,
  inject: [storageConfig.KEY],
  useFactory: (config: ConfigType<typeof storageConfig>): S3Client =>
    new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: true,
    }),
};

export const s3PresignClientProvider: Provider = {
  provide: S3_PRESIGN_CLIENT,
  inject: [storageConfig.KEY],
  useFactory: (config: ConfigType<typeof storageConfig>): S3Client =>
    new S3Client({
      region: config.region,
      endpoint: config.publicEndpoint,
      forcePathStyle: true,
      requestChecksumCalculation: 'WHEN_REQUIRED',
    }),
};
