import { randomBytes } from 'node:crypto';
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import type { DataSource } from 'typeorm';
import {
  cleanAllTables,
  createTestDataSource,
} from './create-test-data-source';
import { TEST_BUCKET_NAME, TEST_DATABASE_NAME } from './test-environment';
import {
  createAdminDataSource,
  createDatabaseIfMissing,
  ensureTestBucket,
  ensureTestDatabase,
} from './test-infrastructure';

async function withEnv(
  overrides: Record<string, string>,
  action: () => unknown,
): Promise<void> {
  const previous = Object.fromEntries(
    Object.keys(overrides).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, overrides);
  try {
    await action();
  } finally {
    Object.assign(process.env, previous);
  }
}

describe('test infrastructure (integration)', () => {
  let admin: DataSource;

  beforeAll(async () => {
    admin = createAdminDataSource();
    await admin.initialize();
  });

  afterAll(async () => {
    await admin.destroy();
  });

  async function countDatabases(name: string): Promise<number> {
    const rows = await admin.query<{ count: string }[]>(
      'SELECT count(*) FROM pg_database WHERE datname = $1',
      [name],
    );
    return Number(rows[0].count);
  }

  describe('createDatabaseIfMissing', () => {
    let temporaryDatabase: string;

    beforeEach(() => {
      temporaryDatabase = `streamtube_test_tmp_${randomBytes(4).toString('hex')}`;
    });

    afterEach(async () => {
      await admin.query(`DROP DATABASE IF EXISTS "${temporaryDatabase}"`);
    });

    it('should create a missing database and accept a repeated call', async () => {
      await createDatabaseIfMissing(admin, temporaryDatabase);
      await createDatabaseIfMissing(admin, temporaryDatabase);

      expect(await countDatabases(temporaryDatabase)).toBe(1);
    });

    it('should tolerate concurrent creation of the same database', async () => {
      await expect(
        Promise.all([
          createDatabaseIfMissing(admin, temporaryDatabase),
          createDatabaseIfMissing(admin, temporaryDatabase),
        ]),
      ).resolves.toBeDefined();

      expect(await countDatabases(temporaryDatabase)).toBe(1);
    });

    it('should reject an unsafe database name', async () => {
      await expect(
        createDatabaseIfMissing(admin, 'streamtube"; DROP DATABASE x; --'),
      ).rejects.toThrow('Invalid database name');
    });
  });

  describe('ensureTestDatabase', () => {
    it('should keep a single test database across repeated calls', async () => {
      await ensureTestDatabase();
      await ensureTestDatabase();

      expect(await countDatabases(TEST_DATABASE_NAME)).toBe(1);
    });

    it.each(['DB_NAME', 'DB_DATABASE'])(
      'should refuse to run when %s is not the test database',
      async (key) => {
        await withEnv({ [key]: 'streamtube' }, async () => {
          await expect(ensureTestDatabase()).rejects.toThrow(
            'Refusing to run tests',
          );
        });
      },
    );
  });

  describe('ensureTestBucket', () => {
    it('should keep the test bucket available across repeated calls', async () => {
      await ensureTestBucket();
      await ensureTestBucket();

      const client = new S3Client({
        region: process.env.S3_REGION,
        endpoint: process.env.S3_ENDPOINT,
        forcePathStyle: true,
      });
      try {
        await expect(
          client.send(new HeadBucketCommand({ Bucket: TEST_BUCKET_NAME })),
        ).resolves.toBeDefined();
      } finally {
        client.destroy();
      }
    });

    it('should refuse to run with the development bucket', async () => {
      await withEnv({ S3_BUCKET: 'streamtube' }, async () => {
        await expect(ensureTestBucket()).rejects.toThrow(
          'Refusing to run tests',
        );
      });
    });
  });

  describe('test data source guards', () => {
    it('should refuse to create a data source outside the test database', async () => {
      await withEnv({ DB_DATABASE: 'streamtube' }, () => {
        expect(() => createTestDataSource([])).toThrow('Refusing to run tests');
      });
    });

    it('should refuse to clean tables outside the test database', async () => {
      const query = jest.fn();
      const developmentDataSource = {
        options: { database: 'streamtube' },
        query,
      } as unknown as DataSource;

      await expect(cleanAllTables(developmentDataSource)).rejects.toThrow(
        'Refusing to clean tables',
      );
      expect(query).not.toHaveBeenCalled();
    });
  });
});
