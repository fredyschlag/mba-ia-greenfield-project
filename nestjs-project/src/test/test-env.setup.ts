import {
  TEST_BUCKET_NAME,
  TEST_DATABASE_NAME,
  TEST_VIDEO_PROCESSING_DLQ_URL,
  TEST_VIDEO_PROCESSING_QUEUE_URL,
} from './test-environment';

// Runs before dotenv, which never overrides a variable that is already set.
// A value exported by the caller is kept, so the test guards can reject it.
process.env.DB_NAME ??= TEST_DATABASE_NAME;
process.env.DB_DATABASE ??= TEST_DATABASE_NAME;
process.env.S3_BUCKET ??= TEST_BUCKET_NAME;
process.env.SQS_VIDEO_PROCESSING_QUEUE_URL ??= TEST_VIDEO_PROCESSING_QUEUE_URL;
process.env.SQS_VIDEO_PROCESSING_DLQ_URL ??= TEST_VIDEO_PROCESSING_DLQ_URL;
