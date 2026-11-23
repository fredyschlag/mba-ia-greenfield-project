export const TEST_DATABASE_NAME = 'streamtube_test';
export const TEST_BUCKET_NAME = 'streamtube-test';
export const TEST_VIDEO_PROCESSING_QUEUE_URL =
  'http://elasticmq:9324/000000000000/video-processing-test';
export const TEST_VIDEO_PROCESSING_DLQ_URL =
  'http://elasticmq:9324/000000000000/video-processing-test-dlq';

export function assertTestDatabase(): void {
  const { DB_NAME, DB_DATABASE } = process.env;
  if (DB_NAME !== TEST_DATABASE_NAME || DB_DATABASE !== TEST_DATABASE_NAME) {
    throw new Error(
      `Refusing to run tests: DB_NAME and DB_DATABASE must be "${TEST_DATABASE_NAME}"`,
    );
  }
}

export function assertTestBucket(): void {
  if (process.env.S3_BUCKET !== TEST_BUCKET_NAME) {
    throw new Error(
      `Refusing to run tests: S3_BUCKET must be "${TEST_BUCKET_NAME}"`,
    );
  }
}
