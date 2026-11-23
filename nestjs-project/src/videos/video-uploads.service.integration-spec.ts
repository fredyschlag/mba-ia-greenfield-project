import { randomUUID } from 'node:crypto';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, EntityManager, type Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import { VideoProcessingQueueService } from '../queue/video-processing-queue.service';
import { videoSourceKey } from '../storage/storage-keys';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { ALL_ENTITIES } from '../test/migration-list';
import { signedRequest } from '../test/signed-request';
import {
  createTestSqsClient,
  peekMessageBodies,
  purgeTestQueues,
  queueDepth,
} from '../test/test-queues';
import { User } from '../users/entities/user.entity';
import { VideoStatus } from './entities/video-status.enum';
import { Video } from './entities/video.entity';
import { generateVideoSlug } from './video-slug.util';
import { VideoUploadsService } from './video-uploads.service';
import {
  ActiveUploadLimitReachedException,
  VideoNotFoundException,
  VideoTooLargeException,
} from './video.exceptions';
import { VideosModule } from './videos.module';

jest.mock('./video-slug.util', () => {
  const actual =
    jest.requireActual<typeof import('./video-slug.util')>('./video-slug.util');
  return {
    ...actual,
    generateVideoSlug: jest.fn(actual.generateVideoSlug),
  };
});

const REDUCED_LIMIT_BYTES = 1_048_576;
const TEST_TIMEOUT_MS = 30_000;

describe('VideoUploadsService (integration)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let service: VideoUploadsService;
  let storage: StorageService;
  let queue: VideoProcessingQueueService;
  let sqs: SQSClient;
  let videoRepository: Repository<Video>;
  let userId: string;
  let channelId: string;

  async function readUploadId(id: string): Promise<string> {
    const video = await videoRepository
      .createQueryBuilder('video')
      .addSelect('video.upload_id')
      .where('video.id = :id', { id })
      .getOneOrFail();
    return video.upload_id!;
  }

  async function createUserWithChannel(): Promise<{
    userId: string;
    channelId: string;
  }> {
    const user = await dataSource.getRepository(User).save({
      email: `upload_${randomUUID()}@example.com`,
      password: 'hashed',
    });
    const channel = await dataSource.getRepository(Channel).save({
      name: 'Upload channel',
      nickname: `upload_${randomUUID().slice(0, 8)}`,
      user_id: user.id,
    });
    return { userId: user.id, channelId: channel.id };
  }

  async function cleanStorage(): Promise<void> {
    const videos = await videoRepository
      .createQueryBuilder('video')
      .addSelect('video.upload_id')
      .getMany();
    for (const video of videos) {
      const key = videoSourceKey(video.id);
      if (video.upload_id) {
        await storage.abortMultipartUpload(key, video.upload_id);
      }
      await storage.deleteObject(key);
    }
  }

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
    })
      .overrideProvider(videoConfig.KEY)
      .useValue({ maxUploadBytes: REDUCED_LIMIT_BYTES })
      .compile();

    dataSource = moduleRef.get(DataSource);
    service = moduleRef.get(VideoUploadsService);
    storage = moduleRef.get(StorageService);
    queue = moduleRef.get(VideoProcessingQueueService);
    sqs = createTestSqsClient();
    videoRepository = dataSource.getRepository(Video);
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await purgeTestQueues(sqs);
    sqs.destroy();
    await moduleRef.close();
  });

  beforeEach(async () => {
    await purgeTestQueues(sqs);
    await cleanAllTables(dataSource);
    ({ userId, channelId } = await createUserWithChannel());
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await cleanStorage();
  }, TEST_TIMEOUT_MS);

  describe('startUpload', () => {
    it(
      'should persist the draft and open the multipart at the video key',
      async () => {
        const result = await service.startUpload(userId, {
          filename: 'aula final.mp4',
          sizeBytes: 1024,
        });

        const video = await videoRepository
          .createQueryBuilder('video')
          .addSelect('video.upload_id')
          .where('video.id = :id', { id: result.id })
          .getOneOrFail();

        expect(video).toMatchObject({
          channel_id: channelId,
          slug: result.slug,
          status: VideoStatus.DRAFT,
          original_filename: 'aula final.mp4',
          declared_size_bytes: 1024,
          part_count: 1,
        });
        await expect(
          storage.listAllParts(videoSourceKey(video.id), video.upload_id!),
        ).resolves.toEqual([]);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'should enforce the limit configured by environment',
      async () => {
        await expect(
          service.startUpload(userId, {
            filename: 'limit.mp4',
            sizeBytes: REDUCED_LIMIT_BYTES,
          }),
        ).resolves.toMatchObject({ partCount: 1 });

        await expect(
          service.startUpload(userId, {
            filename: 'over.mp4',
            sizeBytes: REDUCED_LIMIT_BYTES + 1,
          }),
        ).rejects.toBeInstanceOf(VideoTooLargeException);
        expect(await videoRepository.count()).toBe(1);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'should retry with a new slug after a collision',
      async () => {
        const first = await service.startUpload(userId, {
          filename: 'first.mp4',
          sizeBytes: 1024,
        });
        const freshSlug = 'freshSlug01';
        jest
          .mocked(generateVideoSlug)
          .mockReturnValueOnce(first.slug)
          .mockReturnValueOnce(freshSlug);

        const second = await service.startUpload(userId, {
          filename: 'second.mp4',
          sizeBytes: 1024,
        });

        expect(second.slug).toBe(freshSlug);
        expect(await videoRepository.count()).toBe(2);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'should create at most 3 drafts under concurrent requests',
      async () => {
        const createSpy = jest.spyOn(storage, 'createMultipartUpload');
        const abortSpy = jest.spyOn(storage, 'abortMultipartUpload');

        const results = await Promise.allSettled(
          Array.from({ length: 4 }, (_, index) =>
            service.startUpload(userId, {
              filename: `video-${index}.mp4`,
              sizeBytes: 1024,
            }),
          ),
        );

        const rejected = results.filter(
          (result): result is PromiseRejectedResult =>
            result.status === 'rejected',
        );
        expect(results.length - rejected.length).toBe(3);
        expect(rejected).toHaveLength(1);
        expect(rejected[0].reason).toBeInstanceOf(
          ActiveUploadLimitReachedException,
        );
        expect(await videoRepository.countBy({ channel_id: channelId })).toBe(
          3,
        );
        expect(createSpy.mock.calls.length - abortSpy.mock.calls.length).toBe(
          3,
        );
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'should abort the real multipart when persistence fails',
      async () => {
        const createSpy = jest.spyOn(storage, 'createMultipartUpload');
        jest
          .spyOn(EntityManager.prototype, 'insert')
          .mockRejectedValueOnce(new Error('persistence failed'));

        await expect(
          service.startUpload(userId, {
            filename: 'broken.mp4',
            sizeBytes: 1024,
          }),
        ).rejects.toThrow('persistence failed');

        const key = createSpy.mock.calls[0][0];
        const uploadId = (await createSpy.mock.results[0].value) as string;
        await expect(storage.listAllParts(key, uploadId)).resolves.toBeNull();
        expect(await videoRepository.count()).toBe(0);
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe('signParts and listUploadedParts', () => {
    it(
      'should upload through a signed URL and resume from the stored parts',
      async () => {
        const draft = await service.startUpload(userId, {
          filename: 'resume.mp4',
          sizeBytes: 2048,
        });
        const { parts } = await service.signParts(userId, draft.id, {
          partNumbers: [1],
        });

        const uploaded = await signedRequest(parts[0].url, {
          method: 'PUT',
          body: Buffer.alloc(parts[0].contentLength, 'r'),
        });
        expect(uploaded.status).toBe(200);

        const resumed = await service.listUploadedParts(userId, draft.id);
        expect(resumed.parts).toEqual([
          { partNumber: 1, sizeBytes: 2048, etag: uploaded.headers.etag },
        ]);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'should not expose the upload of another channel',
      async () => {
        const draft = await service.startUpload(userId, {
          filename: 'private.mp4',
          sizeBytes: 1024,
        });
        const other = await createUserWithChannel();

        await expect(
          service.signParts(other.userId, draft.id, { partNumbers: [1] }),
        ).rejects.toBeInstanceOf(VideoNotFoundException);
        await expect(
          service.listUploadedParts(other.userId, draft.id),
        ).rejects.toBeInstanceOf(VideoNotFoundException);
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe('completeUpload', () => {
    async function createUploadedDraft(): Promise<{
      id: string;
      parts: { partNumber: number; etag: string }[];
    }> {
      const draft = await service.startUpload(userId, {
        filename: 'complete.mp4',
        sizeBytes: 1024,
      });
      const signed = await service.signParts(userId, draft.id, {
        partNumbers: [1],
      });
      const uploaded = await signedRequest(signed.parts[0].url, {
        method: 'PUT',
        body: Buffer.alloc(1024, 'c'),
      });
      expect(uploaded.status).toBe(200);
      return {
        id: draft.id,
        parts: [{ partNumber: 1, etag: uploaded.headers.etag as string }],
      };
    }

    it(
      'should complete the object, change the status and publish one message',
      async () => {
        const { id, parts } = await createUploadedDraft();

        await expect(
          service.completeUpload(userId, id, { parts }),
        ).resolves.toMatchObject({ id, status: VideoStatus.PROCESSING });

        const video = await videoRepository
          .createQueryBuilder('video')
          .addSelect('video.upload_id')
          .where('video.id = :id', { id })
          .getOneOrFail();
        expect(video.status).toBe(VideoStatus.PROCESSING);
        expect(video.size_bytes).toBe(1024);
        expect(video.upload_id).toBeNull();
        expect(video.job_enqueued_at).toBeInstanceOf(Date);
        await expect(storage.headObject(videoSourceKey(id))).resolves.toEqual({
          contentLength: 1024,
        });
        await expect(queueDepth(sqs)).resolves.toEqual({
          visible: 1,
          inFlight: 0,
        });
        await expect(peekMessageBodies(sqs)).resolves.toEqual([
          JSON.stringify({ videoId: id }),
        ]);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'should recover when the multipart was completed but the database was not',
      async () => {
        const { id, parts } = await createUploadedDraft();
        const uploadId = await readUploadId(id);
        await storage.completeMultipartUpload(
          videoSourceKey(id),
          uploadId,
          parts,
        );

        await expect(
          service.completeUpload(userId, id, { parts }),
        ).resolves.toMatchObject({ status: VideoStatus.PROCESSING });

        await expect(queueDepth(sqs)).resolves.toEqual({
          visible: 1,
          inFlight: 0,
        });
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'should keep processing with a null job_enqueued_at when enqueue fails',
      async () => {
        const { id, parts } = await createUploadedDraft();
        jest.spyOn(Logger.prototype, 'error').mockImplementation();
        jest
          .spyOn(queue, 'enqueue')
          .mockRejectedValueOnce(new Error('queue unavailable'));

        await expect(
          service.completeUpload(userId, id, { parts }),
        ).resolves.toMatchObject({ status: VideoStatus.PROCESSING });

        const video = await videoRepository.findOneByOrFail({ id });
        expect(video.status).toBe(VideoStatus.PROCESSING);
        expect(video.job_enqueued_at).toBeNull();
        await expect(queueDepth(sqs)).resolves.toEqual({
          visible: 0,
          inFlight: 0,
        });
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'should publish a single message for concurrent completions',
      async () => {
        const { id, parts } = await createUploadedDraft();

        const results = await Promise.allSettled([
          service.completeUpload(userId, id, { parts }),
          service.completeUpload(userId, id, { parts }),
        ]);

        expect(results.map((result) => result.status)).toEqual([
          'fulfilled',
          'fulfilled',
        ]);
        await expect(queueDepth(sqs)).resolves.toEqual({
          visible: 1,
          inFlight: 0,
        });
      },
      TEST_TIMEOUT_MS,
    );
  });
});
