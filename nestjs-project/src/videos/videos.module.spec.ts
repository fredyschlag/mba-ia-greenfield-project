import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import { createTestDataSource } from '../test/create-test-data-source';
import { ALL_ENTITIES } from '../test/migration-list';
import { VideoUploadsService } from './video-uploads.service';
import { VideosController } from './videos.controller';
import { VideosModule } from './videos.module';

describe('VideosModule', () => {
  it('should compile with its controller and services', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [queueConfig, storageConfig, videoConfig],
        }),
        TypeOrmModule.forRoot(
          createTestDataSource(ALL_ENTITIES, { synchronize: false }).options,
        ),
        VideosModule,
      ],
    }).compile();

    expect(moduleRef.get(VideosController)).toBeInstanceOf(VideosController);
    expect(moduleRef.get(VideoUploadsService)).toBeInstanceOf(
      VideoUploadsService,
    );
    await moduleRef.close();
  });
});
