import { DataSource } from 'typeorm';
import { createTestDataSource } from '../test/create-test-data-source';
import { ALL_ENTITIES, ALL_MIGRATIONS } from '../test/migration-list';

// Dropped in this order, because videos references channels.
const MANAGED_TABLES = [
  'videos',
  'refresh_tokens',
  'verification_tokens',
  'channels',
  'users',
];
const MANAGED_ENUMS = ['verification_tokens_type_enum', 'videos_status_enum'];

describe('Database migrations (integration)', () => {
  let dataSource: DataSource;

  async function existingTables(tables: string[]): Promise<string[]> {
    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [tables],
    );
    return result.map((r) => r.table_name);
  }

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES, {
      synchronize: false,
      migrations: ALL_MIGRATIONS,
    });

    await dataSource.initialize();

    for (const table of MANAGED_TABLES) {
      await dataSource.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
    }
    await dataSource.query(`DROP TABLE IF EXISTS "migrations" CASCADE`);
    for (const enumName of MANAGED_ENUMS) {
      await dataSource.query(`DROP TYPE IF EXISTS "public"."${enumName}"`);
    }
  });

  afterAll(async () => {
    // The second test undoes the last migration, leaving videos missing.
    // Re-apply so the shared DB is fully migrated when subsequent suites run.
    await dataSource.runMigrations();
    await dataSource.destroy();
  });

  it('should apply all migrations and create all five tables', async () => {
    const ranMigrations = await dataSource.runMigrations();

    expect(ranMigrations).toHaveLength(3);
    expect(await existingTables(MANAGED_TABLES)).toEqual([
      'channels',
      'refresh_tokens',
      'users',
      'verification_tokens',
      'videos',
    ]);
  });

  it('should revert the last migration and remove only videos', async () => {
    await dataSource.undoLastMigration();

    expect(await existingTables(MANAGED_TABLES)).toEqual([
      'channels',
      'refresh_tokens',
      'users',
      'verification_tokens',
    ]);

    const enums = await dataSource.query<unknown[]>(
      `SELECT 1 FROM pg_type WHERE typname = 'videos_status_enum'`,
    );
    expect(enums).toHaveLength(0);
  });
});
