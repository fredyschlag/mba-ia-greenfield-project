import 'dotenv/config';
import {
  BucketAlreadyOwnedByYou,
  CreateBucketCommand,
  PutBucketCorsCommand,
  S3Client,
} from '@aws-sdk/client-s3';

export async function setupStorage(): Promise<void> {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) throw new Error('S3_BUCKET must be set');

  const client = new S3Client({
    region: process.env.S3_REGION,
    endpoint: process.env.S3_ENDPOINT,
    forcePathStyle: true,
  });

  try {
    try {
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
    } catch (error) {
      if (!(error instanceof BucketAlreadyOwnedByYou)) throw error;
    }

    // MinIO configures CORS through MINIO_API_CORS_ALLOW_ORIGIN and ignores
    // PutBucketCors, so the bucket rule applies only to real S3.
    if (!process.env.S3_ENDPOINT) {
      const origins = process.env.S3_CORS_ALLOWED_ORIGINS?.split(',')
        .map((origin) => origin.trim())
        .filter(Boolean);
      if (!origins?.length) {
        throw new Error('S3_CORS_ALLOWED_ORIGINS must be set for real S3');
      }

      await client.send(
        new PutBucketCorsCommand({
          Bucket: bucket,
          CORSConfiguration: {
            CORSRules: [
              {
                AllowedOrigins: origins,
                AllowedMethods: ['GET', 'HEAD', 'PUT'],
                AllowedHeaders: ['*'],
                ExposeHeaders: ['ETag'],
              },
            ],
          },
        }),
      );
    }
  } finally {
    client.destroy();
  }
}

if (require.main === module) {
  void setupStorage();
}
