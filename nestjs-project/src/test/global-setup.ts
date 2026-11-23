import './test-env.setup';
import 'dotenv/config';
import { createTestDataSource } from './create-test-data-source';
import { ALL_ENTITIES, ALL_MIGRATIONS } from './migration-list';
import { ensureTestBucket, ensureTestDatabase } from './test-infrastructure';

export default async function globalSetup(): Promise<void> {
  await ensureTestDatabase();
  await ensureTestBucket();

  const dataSource = createTestDataSource(ALL_ENTITIES, {
    synchronize: false,
    migrations: ALL_MIGRATIONS,
  });
  await dataSource.initialize();
  try {
    await dataSource.runMigrations();
  } finally {
    await dataSource.destroy();
  }
}
