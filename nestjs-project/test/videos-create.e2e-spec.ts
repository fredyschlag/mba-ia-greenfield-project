import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { videoSourceKey } from '../src/storage/storage-keys';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { VideoStatus } from '../src/videos/entities/video-status.enum';
import {
  cleanVideoStorage,
  createDraft,
  createVideoE2eContext,
  E2E_TIMEOUT_MS,
  readUploadId,
  registerConfirmAndLogin,
  type TestUser,
  type VideoE2eContext,
} from './support/video-e2e';

describe('videos-create', () => {
  let context: VideoE2eContext;
  let userA: TestUser;

  const post = (token?: string) => {
    const call = request(context.app.getHttpServer()).post('/videos');
    return token ? call.set('Authorization', `Bearer ${token}`) : call;
  };
  const validBody = { filename: 'video.mp4', sizeBytes: 1024 };

  beforeAll(async () => {
    context = await createVideoE2eContext();
  }, E2E_TIMEOUT_MS);

  afterAll(async () => {
    await context.app.close();
  });

  beforeEach(async () => {
    context.throttlerStorage.storage.clear();
    await cleanAllTables(context.dataSource);
    userA = await registerConfirmAndLogin(
      context,
      `create_a_${randomUUID()}@example.com`,
    );
  }, E2E_TIMEOUT_MS);

  afterEach(async () => {
    jest.restoreAllMocks();
    await cleanVideoStorage(context);
  }, E2E_TIMEOUT_MS);

  // 1. POST /videos — criação do rascunho

  it(
    'create-draft-video',
    async () => {
      const startedAt = Date.now();

      const response = await post(userA.token)
        .send({ filename: 'aula final.mp4', sizeBytes: 40_000_000 })
        .expect(201);

      const body = response.body as {
        id: string;
        slug: string;
        status: string;
        partSizeBytes: number;
        partCount: number;
        uploadExpiresAt: string;
      };
      expect(body.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(body.slug).toMatch(/^[0-9A-Za-z]{11}$/);
      expect(body).toMatchObject({
        status: 'draft',
        partSizeBytes: 16_777_216,
        partCount: 3,
      });
      const expiresInMs = new Date(body.uploadExpiresAt).getTime() - startedAt;
      expect(Math.abs(expiresInMs - 48 * 60 * 60 * 1000)).toBeLessThan(60_000);

      const channel = await context.channels.findOneByOrFail({
        user_id: userA.id,
      });
      const video = await context.videos.findOneByOrFail({ id: body.id });
      const uploadId = await readUploadId(context, body.id);
      expect(video).toMatchObject({
        channel_id: channel.id,
        status: VideoStatus.DRAFT,
        original_filename: 'aula final.mp4',
        declared_size_bytes: 40_000_000,
      });
      expect(uploadId).toEqual(expect.any(String));

      const key = videoSourceKey(body.id);
      await expect(
        context.storage.listAllParts(key, uploadId!),
      ).resolves.toEqual([]);
      expect(key).not.toContain('aula final.mp4');
    },
    E2E_TIMEOUT_MS,
  );

  it(
    'accept-maximum-size-with-640-parts',
    async () => {
      const response = await post(userA.token)
        .send({ filename: 'limite.mp4', sizeBytes: 10_737_418_240 })
        .expect(201);

      const body = response.body as {
        id: string;
        partSizeBytes: number;
        partCount: number;
      };
      expect(body.partSizeBytes).toBe(16_777_216);
      expect(body.partCount).toBe(640);
      const video = await context.videos.findOneByOrFail({ id: body.id });
      expect(video.declared_size_bytes).toBe(10_737_418_240);
    },
    E2E_TIMEOUT_MS,
  );

  // 2. POST /videos — contrato da requisição

  it(
    'reject-invalid-request-body',
    async () => {
      const createSpy = jest.spyOn(context.storage, 'createMultipartUpload');
      const invalidBodies: unknown[] = [
        { sizeBytes: 1024 },
        { filename: '', sizeBytes: 1024 },
        { filename: 'a'.repeat(256), sizeBytes: 1024 },
        { filename: 'video.mp4' },
        { filename: 'video.mp4', sizeBytes: 0 },
        { filename: 'video.mp4', sizeBytes: -1 },
        { filename: 'video.mp4', sizeBytes: 1.5 },
        { filename: 'video.mp4', sizeBytes: '100' },
        { filename: 'video.mp4', sizeBytes: 1024, status: 'ready' },
      ];

      for (const body of invalidBodies) {
        await post(userA.token)
          .send(body as object)
          .expect(400);
      }

      expect(await context.videos.count()).toBe(0);
      expect(createSpy).not.toHaveBeenCalled();
    },
    E2E_TIMEOUT_MS,
  );

  it(
    'reject-request-without-token',
    async () => {
      const createSpy = jest.spyOn(context.storage, 'createMultipartUpload');

      await post().send(validBody).expect(401);
      await post('malformed-token').send(validBody).expect(401);

      expect(await context.videos.count()).toBe(0);
      expect(createSpy).not.toHaveBeenCalled();
    },
    E2E_TIMEOUT_MS,
  );

  // 3. POST /videos — erros de domínio e limites

  it(
    'reject-size-above-limit',
    async () => {
      const createSpy = jest.spyOn(context.storage, 'createMultipartUpload');

      const response = await post(userA.token)
        .send({ filename: 'grande.mp4', sizeBytes: 10_737_418_241 })
        .expect(413);

      expect(response.body).toMatchObject({
        statusCode: 413,
        error: 'VIDEO_TOO_LARGE',
      });
      expect(await context.videos.count()).toBe(0);
      expect(createSpy).not.toHaveBeenCalled();
    },
    E2E_TIMEOUT_MS,
  );

  it(
    'reject-fourth-active-upload',
    async () => {
      const createSpy = jest.spyOn(context.storage, 'createMultipartUpload');
      const abortSpy = jest.spyOn(context.storage, 'abortMultipartUpload');
      for (let index = 0; index < 3; index += 1) {
        await createDraft(context, userA.token, 1024);
      }

      const response = await post(userA.token).send(validBody).expect(409);

      expect(response.body).toMatchObject({
        error: 'ACTIVE_UPLOAD_LIMIT_REACHED',
      });
      expect(await context.videos.count()).toBe(3);
      expect(createSpy.mock.calls.length - abortSpy.mock.calls.length).toBe(3);
    },
    E2E_TIMEOUT_MS,
  );

  it(
    'limit-concurrent-uploads-per-channel',
    async () => {
      const createSpy = jest.spyOn(context.storage, 'createMultipartUpload');
      const abortSpy = jest.spyOn(context.storage, 'abortMultipartUpload');

      const responses = await Promise.all(
        Array.from({ length: 4 }, () => post(userA.token).send(validBody)),
      );

      const statuses = responses.map((response) => response.status).sort();
      expect(statuses).toEqual([201, 201, 201, 409]);
      const rejected = responses.find((response) => response.status === 409);
      expect(rejected?.body).toMatchObject({
        error: 'ACTIVE_UPLOAD_LIMIT_REACHED',
      });
      expect(await context.videos.count()).toBe(3);
      expect(createSpy.mock.calls.length - abortSpy.mock.calls.length).toBe(3);
    },
    E2E_TIMEOUT_MS,
  );

  it(
    'ignore-expired-drafts-in-active-limit',
    async () => {
      const drafts = [
        await createDraft(context, userA.token, 1024),
        await createDraft(context, userA.token, 1024),
        await createDraft(context, userA.token, 1024),
      ];
      await context.videos.update(drafts[0].id, {
        upload_expires_at: new Date(Date.now() - 60_000),
      });

      await post(userA.token).send(validBody).expect(201);
    },
    E2E_TIMEOUT_MS,
  );

  it(
    'isolate-active-limit-per-channel',
    async () => {
      const userB = await registerConfirmAndLogin(
        context,
        `create_b_${randomUUID()}@example.com`,
      );
      for (let index = 0; index < 3; index += 1) {
        await createDraft(context, userA.token, 1024);
      }

      const created = await createDraft(context, userB.token, 1024);

      const channelB = await context.channels.findOneByOrFail({
        user_id: userB.id,
      });
      const video = await context.videos.findOneByOrFail({ id: created.id });
      expect(video.channel_id).toBe(channelB.id);
    },
    E2E_TIMEOUT_MS,
  );

  it(
    'reject-user-without-channel',
    async () => {
      const createSpy = jest.spyOn(context.storage, 'createMultipartUpload');
      await context.channels.delete({ user_id: userA.id });
      expect(await context.channels.countBy({ user_id: userA.id })).toBe(0);

      const response = await post(userA.token).send(validBody).expect(404);

      expect(response.body).toMatchObject({ error: 'CHANNEL_NOT_FOUND' });
      expect(createSpy).not.toHaveBeenCalled();
    },
    E2E_TIMEOUT_MS,
  );
});
