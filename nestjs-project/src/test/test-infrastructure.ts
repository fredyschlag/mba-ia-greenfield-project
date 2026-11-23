import {
  BucketAlreadyOwnedByYou,
  CreateBucketCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { DataSource } from 'typeorm';
import {
  assertTestBucket,
  assertTestDatabase,
  TEST_BUCKET_NAME,
  TEST_DATABASE_NAME,
} from './test-environment';

const POSTGRES_DUPLICATE_DATABASE = '42P04';
const POSTGRES_UNIQUE_VIOLATION = '23505';
const SAFE_DATABASE_NAME = /^[a-z0-9_]+$/;

interface PostgresError {
  code?: string;
  driverError?: { code?: string };
}

function isDuplicateDatabaseError(error: unknown): boolean {
  const { code, driverError } = error as PostgresError;
  const postgresCode = driverError?.code ?? code;
  return (
    postgresCode === POSTGRES_DUPLICATE_DATABASE ||
    postgresCode === POSTGRES_UNIQUE_VIOLATION
  );
}

export function createAdminDataSource(): DataSource {
  return new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 5432),
    username: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: 'postgres',
  });
}

export async function createDatabaseIfMissing(
  admin: DataSource,
  databaseName: string,
): Promise<void> {
  if (!SAFE_DATABASE_NAME.test(databaseName)) {
    throw new Error(`Invalid database name: ${databaseName}`);
  }

  const existing = await admin.query<unknown[]>(
    'SELECT 1 FROM pg_database WHERE datname = $1',
    [databaseName],
  );
  if (existing.length > 0) return;

  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
  } catch (error) {
    if (!isDuplicateDatabaseError(error)) throw error;
  }
}

export async function ensureTestDatabase(): Promise<void> {
  assertTestDatabase();

  const admin = createAdminDataSource();
  await admin.initialize();
  try {
    await createDatabaseIfMissing(admin, TEST_DATABASE_NAME);
  } finally {
    await admin.destroy();
  }
}

export async function ensureTestBucket(): Promise<void> {
  assertTestBucket();

  const client = new S3Client({
    region: process.env.S3_REGION,
    endpoint: process.env.S3_ENDPOINT,
    forcePathStyle: true,
  });
  try {
    await client.send(new CreateBucketCommand({ Bucket: TEST_BUCKET_NAME }));
  } catch (error) {
    if (!(error instanceof BucketAlreadyOwnedByYou)) throw error;
  } finally {
    client.destroy();
  }
}
