import {
  DataSource,
  type DataSourceOptions,
  MigrationInterface,
} from 'typeorm';
import { assertTestDatabase, TEST_DATABASE_NAME } from './test-environment';

interface TestDataSourceOptions {
  synchronize?: boolean;
  migrations?: (new () => MigrationInterface)[];
}

export function createTestDataSource(
  entities: NonNullable<DataSourceOptions['entities']>,
  options: TestDataSourceOptions = {},
): DataSource {
  assertTestDatabase();

  const { synchronize = true, migrations } = options;
  return new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST ?? 'db',
    port: Number(process.env.DB_PORT ?? 5432),
    username: process.env.DB_USERNAME ?? 'streamtube',
    password: process.env.DB_PASSWORD ?? 'streamtube',
    database: TEST_DATABASE_NAME,
    entities,
    synchronize,
    ...(migrations !== undefined && { migrations, migrationsRun: false }),
  });
}

export async function cleanAllTables(dataSource: DataSource): Promise<void> {
  if (dataSource.options.database !== TEST_DATABASE_NAME) {
    throw new Error(`Refusing to clean tables outside "${TEST_DATABASE_NAME}"`);
  }

  await dataSource.query('DELETE FROM "refresh_tokens"');
  await dataSource.query('DELETE FROM "verification_tokens"');
  await dataSource.query('DELETE FROM "videos"');
  await dataSource.query('DELETE FROM "channels"');
  await dataSource.query('DELETE FROM "users"');
}
