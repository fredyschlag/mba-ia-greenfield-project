import { SQSClient } from '@aws-sdk/client-sqs';
import type { Provider } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import queueConfig from '../config/queue.config';
import { SQS_CLIENT } from './queue.constants';

export const sqsClientProvider: Provider = {
  provide: SQS_CLIENT,
  inject: [queueConfig.KEY],
  useFactory: (config: ConfigType<typeof queueConfig>): SQSClient =>
    new SQSClient({
      region: config.region,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    }),
};
