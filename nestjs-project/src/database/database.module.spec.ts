import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { TEST_DATABASE_NAME } from '../test/test-environment';
import { DatabaseModule } from './database.module';

describe('DatabaseModule', () => {
  it('should compile and connect to the configured database', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [DatabaseModule],
    }).compile();

    const dataSource = moduleRef.get(DataSource);

    expect(dataSource.isInitialized).toBe(true);
    expect(dataSource.options.database).toBe(TEST_DATABASE_NAME);
    await moduleRef.close();
  });
});
