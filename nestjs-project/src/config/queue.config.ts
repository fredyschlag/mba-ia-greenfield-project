import { registerAs } from '@nestjs/config';

export default registerAs('queue', () => ({
  endpoint: process.env.SQS_ENDPOINT || undefined,
  region: process.env.SQS_REGION!,
  videoProcessingQueueUrl: process.env.SQS_VIDEO_PROCESSING_QUEUE_URL!,
  videoProcessingDlqUrl: process.env.SQS_VIDEO_PROCESSING_DLQ_URL!,
}));
