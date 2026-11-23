import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { VideoProcessingQueueService } from '../src/queue/video-processing-queue.service';
import { videoSourceKey } from '../src/storage/storage-keys';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { signedRequest } from '../src/test/signed-request';
import { createTestSqsClient, purgeTestQueues } from '../src/test/test-queues';
import {
  generateMp4Fixture,
  insertTestVideo,
} from '../src/test/video-fixtures';
import { VideoProcessorService } from '../src/video-worker/video-processor.service';
import { VideoWorkerModule } from '../src/video-worker/video-worker.module';
import { VideoStatus } from '../src/videos/entities/video-status.enum';
import type { Video } from '../src/videos/entities/video.entity';
import {
  cleanVideoStorage,
  createDraft,
  createVideoE2eContext,
  E2E_TIMEOUT_MS,
  registerConfirmAndLogin,
  type TestUser,
  uploadPart,
  type VideoE2eContext,
} from './support/video-e2e';

const SETUP_TIMEOUT_MS = 120_000;
const ACCESS_ROUTES = ['', '/playback', '/download'] as const;
const NOT_READY_STATUSES = [
  VideoStatus.DRAFT,
  VideoStatus.PROCESSING,
  VideoStatus.FAILED,
];

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

describe('Video access (e2e)', () => {
  let context: VideoE2eContext;
  let workerModule: TestingModule;
  let processor: VideoProcessorService;
  let queue: VideoProcessingQueueService;
  let sqs: SQSClient;
  let workDir: string;
  let fixture: Buffer;
  let userA: TestUser;
  let userB: TestUser;
  let channelAId: string;

  function get(path: string, token?: string): request.Test {
    const call = request(context.app.getHttpServer()).get(path);
    return token ? call.set('Authorization', `Bearer ${token}`) : call;
  }

  function insertVideo(overrides: Partial<Video> = {}): Promise<Video> {
    return insertTestVideo(context.dataSource, channelAId, {
      status: VideoStatus.READY,
      content_type: 'video/mp4',
      duration_seconds: 60,
      ...overrides,
    });
  }

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'videos-access-'));
    fixture = await generateMp4Fixture(workDir);
    context = await createVideoE2eContext();
    // Compiled without init, so no consumer or scheduled job is started.
    workerModule = await Test.createTestingModule({
      imports: [VideoWorkerModule],
    }).compile();
    processor = workerModule.get(VideoProcessorService);
    queue = context.app.get(VideoProcessingQueueService, { strict: false });
    sqs = createTestSqsClient();
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await purgeTestQueues(sqs);
    sqs.destroy();
    await workerModule.close();
    await context.app.close();
    await rm(workDir, { recursive: true, force: true });
  }, E2E_TIMEOUT_MS);

  beforeEach(async () => {
    context.throttlerStorage.storage.clear();
    await cleanAllTables(context.dataSource);
    await purgeTestQueues(sqs);
    userA = await registerConfirmAndLogin(
      context,
      `access_a_${randomUUID()}@example.com`,
    );
    userB = await registerConfirmAndLogin(
      context,
      `access_b_${randomUUID()}@example.com`,
    );
    const channel = await context.channels.findOneByOrFail({
      user_id: userA.id,
    });
    channelAId = channel.id;
  }, E2E_TIMEOUT_MS);

  afterEach(async () => {
    await cleanVideoStorage(context);
  }, E2E_TIMEOUT_MS);

  describe('complete flow', () => {
    it(
      'complete-video-flow-to-ready',
      async () => {
        const draft = await createDraft(
          context,
          userA.token,
          fixture.length,
          'clip.mp4',
        );
        const etag = await uploadPart(
          context,
          userA.token,
          draft.id,
          1,
          fixture,
        );

        const completed = await request(context.app.getHttpServer())
          .post(`/videos/${draft.id}/upload/complete`)
          .set('Authorization', `Bearer ${userA.token}`)
          .send({ parts: [{ partNumber: 1, etag }] })
          .expect(202);
        expect(completed.body).toMatchObject({ status: 'processing' });

        const message = await queue.receive(5);
        expect(message?.videoId).toBe(draft.id);
        await expect(processor.process(draft.id)).resolves.toBe('ready');
        await queue.delete(message!.receiptHandle);

        const video = await get(`/videos/${draft.slug}`, userA.token).expect(
          200,
        );
        const body = video.body as {
          status: string;
          durationSeconds: number;
          width: number;
          height: number;
          videoCodec: string;
          audioCodec: string;
          container: string;
          contentType: string;
          thumbnailUrl: string;
        };
        expect(body.status).toBe('ready');
        expect(body.durationSeconds).toBeCloseTo(2, 0);
        expect(body.width).toBe(320);
        expect(body.height).toBe(180);
        expect(body.videoCodec).toBe('h264');
        expect(body.audioCodec).toBe('aac');
        expect(body.container).toBe('mp4');
        expect(body.contentType).toBe('video/mp4');
        expect(body.thumbnailUrl).toContain('X-Amz-Signature=');

        const thumbnail = await signedRequest(body.thumbnailUrl);
        expect(thumbnail.status).toBe(200);
        expect(thumbnail.body.subarray(0, 3)).toEqual(
          Buffer.from([0xff, 0xd8, 0xff]),
        );

        const playback = await get(
          `/videos/${draft.slug}/playback`,
          userA.token,
        ).expect(200);
        const { url: playbackUrl, expiresAt } = playback.body as {
          url: string;
          expiresAt: string;
        };
        expect(Number.isNaN(Date.parse(expiresAt))).toBe(false);
        const range = await signedRequest(playbackUrl, {
          headers: { Range: 'bytes=0-1023' },
        });
        expect(range.status).toBe(206);
        expect(range.headers['content-range']).toMatch(/^bytes 0-1023\//);
        expect(range.headers['content-length']).toBe('1024');
        expect(range.headers['content-type']).toBe(body.contentType);
        expect(range.headers['content-disposition']).toMatch(/^inline/);

        const download = await get(
          `/videos/${draft.slug}/download`,
          userA.token,
        ).expect(200);
        const downloadBody = download.body as {
          url: string;
          expiresAt: string;
        };
        expect(downloadBody.expiresAt).toEqual(expect.any(String));
        const file = await signedRequest(downloadBody.url);
        expect(file.status).toBe(200);
        expect(file.headers['content-disposition']).toMatch(/^attachment/);
        expect(sha256(file.body)).toBe(sha256(fixture));
      },
      E2E_TIMEOUT_MS,
    );
  });

  describe('GET /videos/:slug', () => {
    it(
      'get-video-before-ready',
      async () => {
        for (const status of NOT_READY_STATUSES) {
          const video = await insertVideo({
            status,
            content_type: null,
            duration_seconds: null,
            failure_code:
              status === VideoStatus.FAILED ? 'UNSUPPORTED_FORMAT' : null,
          });

          const response = await get(
            `/videos/${video.slug}`,
            userA.token,
          ).expect(200);

          expect(response.body).toMatchObject({
            status,
            thumbnailUrl: null,
            failureCode:
              status === VideoStatus.FAILED ? 'UNSUPPORTED_FORMAT' : null,
          });
        }
      },
      E2E_TIMEOUT_MS,
    );
  });

  describe('GET /videos/:slug/playback', () => {
    it(
      'cap-playback-url-at-7-days',
      async () => {
        const video = await insertVideo({ duration_seconds: 302401 });
        const before = Date.now();

        const response = await get(
          `/videos/${video.slug}/playback`,
          userA.token,
        ).expect(200);

        const body = response.body as { url: string; expiresAt: string };
        expect(body.url).toContain('X-Amz-Expires=604800');
        const sevenDays = 7 * 24 * 60 * 60 * 1000;
        expect(
          Math.abs(Date.parse(body.expiresAt) - (before + sevenDays)),
        ).toBeLessThan(60_000);
      },
      E2E_TIMEOUT_MS,
    );

    it(
      'calculate-playback-url-validity',
      async () => {
        const short = await insertVideo({ duration_seconds: 60 });
        const long = await insertVideo({ duration_seconds: 7200 });

        const shortResponse = await get(
          `/videos/${short.slug}/playback`,
          userA.token,
        ).expect(200);
        const longResponse = await get(
          `/videos/${long.slug}/playback`,
          userA.token,
        ).expect(200);

        expect((shortResponse.body as { url: string }).url).toContain(
          'X-Amz-Expires=3600',
        );
        expect((longResponse.body as { url: string }).url).toContain(
          'X-Amz-Expires=14400',
        );
      },
      E2E_TIMEOUT_MS,
    );
  });

  describe('GET /videos/:slug/download', () => {
    it(
      'sanitize-download-filename',
      async () => {
        const video = await insertVideo({
          original_filename: 'relatório "final"\r\n/../a\\b.mp4',
        });
        await context.storage.putObject(
          videoSourceKey(video.id),
          Buffer.from('small video content'),
        );

        const response = await get(
          `/videos/${video.slug}/download`,
          userA.token,
        ).expect(200);

        const { url } = response.body as { url: string };
        expect(url).toContain('X-Amz-Expires=21600');
        const file = await signedRequest(url);
        const disposition = file.headers['content-disposition']!;
        expect(disposition).toMatch(/^attachment/);
        expect(disposition).not.toMatch(/[\r\n]/);
        const name = /filename="([^"]*)"/.exec(disposition)![1];
        expect(name).not.toMatch(/["/\\]/);
      },
      E2E_TIMEOUT_MS,
    );
  });

  describe('authorization and errors', () => {
    it(
      'reject-playback-and-download-when-not-ready',
      async () => {
        for (const status of NOT_READY_STATUSES) {
          const video = await insertVideo({ status });
          for (const route of ['/playback', '/download']) {
            const response = await get(
              `/videos/${video.slug}${route}`,
              userA.token,
            ).expect(409);

            expect(response.body).toMatchObject({ error: 'VIDEO_NOT_READY' });
            expect(response.body).not.toHaveProperty('url');
          }
        }
      },
      E2E_TIMEOUT_MS,
    );

    it(
      'hide-video-from-other-channel',
      async () => {
        const video = await insertVideo();

        for (const route of ACCESS_ROUTES) {
          const response = await get(
            `/videos/${video.slug}${route}`,
            userB.token,
          ).expect(404);

          expect(response.body).toMatchObject({ error: 'VIDEO_NOT_FOUND' });
          expect(response.body).not.toHaveProperty('url');
          expect(response.body).not.toHaveProperty('originalFilename');
        }
      },
      E2E_TIMEOUT_MS,
    );

    it(
      'return-not-found-for-unknown-or-invalid-slug',
      async () => {
        const slugs = ['aZ3kP9xQ1bC', 'short', 'aZ3kP9xQ1bCd', 'aZ3kP9xQ1b-'];

        for (const slug of slugs) {
          for (const route of ACCESS_ROUTES) {
            const response = await get(
              `/videos/${slug}${route}`,
              userA.token,
            ).expect(404);

            expect(response.body).toMatchObject({ error: 'VIDEO_NOT_FOUND' });
          }
        }
      },
      E2E_TIMEOUT_MS,
    );

    it(
      'reject-access-without-token',
      async () => {
        const video = await insertVideo();

        for (const route of ACCESS_ROUTES) {
          await get(`/videos/${video.slug}${route}`).expect(401);
          await get(`/videos/${video.slug}${route}`, 'malformed-token').expect(
            401,
          );
        }
      },
      E2E_TIMEOUT_MS,
    );
  });
});
