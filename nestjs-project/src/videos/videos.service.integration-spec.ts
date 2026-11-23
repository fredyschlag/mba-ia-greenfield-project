import { randomBytes } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import { videoSourceKey, videoThumbnailKey } from '../storage/storage-keys';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { ALL_ENTITIES } from '../test/migration-list';
import { signedRequest } from '../test/signed-request';
import { createTestChannel, insertTestVideo } from '../test/video-fixtures';
import { VideoStatus } from './entities/video-status.enum';
import type { Video } from './entities/video.entity';
import { VideoNotFoundException } from './video.exceptions';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const TEST_TIMEOUT_MS = 30_000;
const CONTENT = randomBytes(8 * 1024);

describe('VideosService (integration)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let storage: StorageService;
  let service: VideosService;
  let userId: string;
  let channelId: string;
  let video: Video;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
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
    dataSource = moduleRef.get(DataSource);
    storage = moduleRef.get(StorageService);
    service = moduleRef.get(VideosService);
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await moduleRef.close();
  }, TEST_TIMEOUT_MS);

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const channel = await createTestChannel(dataSource);
    channelId = channel.id;
    userId = channel.user_id;
    video = await insertTestVideo(dataSource, channelId, {
      status: VideoStatus.READY,
      original_filename: 'relatório "final".mp4',
      content_type: 'video/mp4',
      duration_seconds: 60,
    });
    await storage.putObject(videoSourceKey(video.id), CONTENT);
  }, TEST_TIMEOUT_MS);

  afterEach(async () => {
    await storage.deleteObject(videoSourceKey(video.id));
    await storage.deleteObject(videoThumbnailKey(video.id));
  }, TEST_TIMEOUT_MS);

  it(
    'should serve playback with Range, 206 and the signed headers',
    async () => {
      const { url } = await service.getPlayback(userId, video.slug);

      const response = await signedRequest(url, {
        headers: { Range: 'bytes=0-1023' },
      });

      expect(response.status).toBe(206);
      expect(response.headers['content-range']).toBe(
        `bytes 0-1023/${CONTENT.length}`,
      );
      expect(response.headers['content-length']).toBe('1024');
      expect(response.headers['content-type']).toBe('video/mp4');
      expect(response.headers['content-disposition']).toBe('inline');
      expect(response.body).toEqual(CONTENT.subarray(0, 1024));
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'should serve the download as an attachment with a safe name',
    async () => {
      const { url } = await service.getDownload(userId, video.slug);

      const response = await signedRequest(url);

      expect(response.status).toBe(200);
      expect(response.body).toEqual(CONTENT);
      const disposition = response.headers['content-disposition']!;
      expect(disposition).toMatch(
        /^attachment; filename="relatorio final\.mp4"/,
      );
      expect(disposition).toContain("filename*=UTF-8''relat%C3%B3rio");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'should return a thumbnail URL that reads the stored image',
    async () => {
      const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
      await storage.putObject(videoThumbnailKey(video.id), jpeg, 'image/jpeg');
      await dataSource.query(
        'UPDATE "videos" SET "thumbnail_key" = $1 WHERE "id" = $2',
        [videoThumbnailKey(video.id), video.id],
      );

      const { thumbnailUrl } = await service.getVideo(userId, video.slug);

      const response = await signedRequest(thumbnailUrl!);
      expect(response.status).toBe(200);
      expect(response.body).toEqual(jpeg);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'should not find a video of another channel',
    async () => {
      const other = await createTestChannel(dataSource);

      await expect(
        service.getVideo(other.user_id, video.slug),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    },
    TEST_TIMEOUT_MS,
  );
});
