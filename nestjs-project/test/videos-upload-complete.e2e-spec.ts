import { randomUUID } from 'node:crypto';
import type { SQSClient } from '@aws-sdk/client-sqs';
import request from 'supertest';
import { videoSourceKey } from '../src/storage/storage-keys';
import { cleanAllTables } from '../src/test/create-test-data-source';
import {
  createTestSqsClient,
  peekMessageBodies,
  purgeTestQueues,
  queueDepth,
} from '../src/test/test-queues';
import { VideoStatus } from '../src/videos/entities/video-status.enum';
import {
  cleanVideoStorage,
  createDraft,
  createVideoE2eContext,
  E2E_TIMEOUT_MS,
  readUploadId,
  registerConfirmAndLogin,
  type TestUser,
  uploadPart,
  type VideoE2eContext,
} from './support/video-e2e';

interface UploadedDraft {
  id: string;
  slug: string;
  parts: { partNumber: number; etag: string }[];
}

describe('videos-upload-complete', () => {
  let context: VideoE2eContext;
  let sqs: SQSClient;
  let userA: TestUser;
  let userB: TestUser;

  const complete = (id: string, token?: string) => {
    const call = request(context.app.getHttpServer()).post(
      `/videos/${id}/upload/complete`,
    );
    return token ? call.set('Authorization', `Bearer ${token}`) : call;
  };

  async function createUploadedDraft(): Promise<UploadedDraft> {
    const draft = await createDraft(context, userA.token, 1024);
    const etag = await uploadPart(
      context,
      userA.token,
      draft.id,
      1,
      Buffer.alloc(1024, 'a'),
    );
    return {
      id: draft.id,
      slug: draft.slug,
      parts: [{ partNumber: 1, etag }],
    };
  }

  async function completeMultipartDirectly(
    draft: UploadedDraft,
  ): Promise<void> {
    const uploadId = await readUploadId(context, draft.id);
    await context.storage.completeMultipartUpload(
      videoSourceKey(draft.id),
      uploadId!,
      draft.parts,
    );
  }

  beforeAll(async () => {
    context = await createVideoE2eContext();
    sqs = createTestSqsClient();
  }, E2E_TIMEOUT_MS);

  afterAll(async () => {
    await purgeTestQueues(sqs);
    sqs.destroy();
    await context.app.close();
  });

  beforeEach(async () => {
    context.throttlerStorage.storage.clear();
    await cleanAllTables(context.dataSource);
    await purgeTestQueues(sqs);
    userA = await registerConfirmAndLogin(
      context,
      `complete_a_${randomUUID()}@example.com`,
    );
    userB = await registerConfirmAndLogin(
      context,
      `complete_b_${randomUUID()}@example.com`,
    );
  }, E2E_TIMEOUT_MS);

  afterEach(async () => {
    await cleanVideoStorage(context);
  }, E2E_TIMEOUT_MS);

  // 1. POST /videos/:id/upload/complete — conclusão

  it(
    'complete-upload-and-enqueue',
    async () => {
      const draft = await createUploadedDraft();

      const response = await complete(draft.id, userA.token)
        .send({ parts: draft.parts })
        .expect(202);

      expect(response.body).toEqual({
        id: draft.id,
        slug: draft.slug,
        status: 'processing',
      });
      const video = await context.videos.findOneByOrFail({ id: draft.id });
      expect(video.status).toBe(VideoStatus.PROCESSING);
      expect(video.size_bytes).toBe(1024);
      expect(video.job_enqueued_at).toBeInstanceOf(Date);
      await expect(readUploadId(context, draft.id)).resolves.toBeNull();
      await expect(
        context.storage.headObject(videoSourceKey(draft.id)),
      ).resolves.toEqual({ contentLength: 1024 });
      await expect(queueDepth(sqs)).resolves.toEqual({
        visible: 1,
        inFlight: 0,
      });
      await expect(peekMessageBodies(sqs)).resolves.toEqual([
        JSON.stringify({ videoId: draft.id }),
      ]);
    },
    E2E_TIMEOUT_MS,
  );

  it(
    'repeat-complete-without-new-message',
    async () => {
      const draft = await createUploadedDraft();
      await complete(draft.id, userA.token)
        .send({ parts: draft.parts })
        .expect(202);

      const repeated = await complete(draft.id, userA.token)
        .send({ parts: draft.parts })
        .expect(202);

      expect(repeated.body).toMatchObject({ status: 'processing' });
      await expect(queueDepth(sqs)).resolves.toEqual({
        visible: 1,
        inFlight: 0,
      });
    },
    E2E_TIMEOUT_MS,
  );

  it(
    'recover-lost-complete-response',
    async () => {
      const draft = await createUploadedDraft();
      await completeMultipartDirectly(draft);
      await expect(
        context.storage.headObject(videoSourceKey(draft.id)),
      ).resolves.toEqual({ contentLength: 1024 });
      const before = await context.videos.findOneByOrFail({ id: draft.id });
      expect(before.status).toBe(VideoStatus.DRAFT);

      const response = await complete(draft.id, userA.token)
        .send({ parts: draft.parts })
        .expect(202);

      expect(response.body).toMatchObject({ status: 'processing' });
      const video = await context.videos.findOneByOrFail({ id: draft.id });
      expect(video.size_bytes).toBe(1024);
      await expect(queueDepth(sqs)).resolves.toEqual({
        visible: 1,
        inFlight: 0,
      });
    },
    E2E_TIMEOUT_MS,
  );

  it(
    'return-accepted-for-ready-video',
    async () => {
      const draft = await createUploadedDraft();
      await complete(draft.id, userA.token)
        .send({ parts: draft.parts })
        .expect(202);
      await purgeTestQueues(sqs);
      await context.videos.update(draft.id, { status: VideoStatus.READY });
      await expect(queueDepth(sqs)).resolves.toEqual({
        visible: 0,
        inFlight: 0,
      });

      const response = await complete(draft.id, userA.token)
        .send({ parts: draft.parts })
        .expect(202);

      expect(response.body).toMatchObject({ status: 'ready' });
      await expect(queueDepth(sqs)).resolves.toEqual({
        visible: 0,
        inFlight: 0,
      });
    },
    E2E_TIMEOUT_MS,
  );

  // 2. POST /videos/:id/upload/complete — divergências

  it(
    'reject-missing-parts',
    async () => {
      const draft = await createDraft(context, userA.token, 20_000_000);
      const etag = await uploadPart(
        context,
        userA.token,
        draft.id,
        1,
        Buffer.alloc(16_777_216, 'p'),
      );

      const response = await complete(draft.id, userA.token)
        .send({ parts: [{ partNumber: 1, etag }] })
        .expect(409);

      expect(response.body).toMatchObject({ error: 'UPLOAD_INCOMPLETE' });
      const video = await context.videos.findOneByOrFail({ id: draft.id });
      expect(video.status).toBe(VideoStatus.DRAFT);
      const uploadId = await readUploadId(context, draft.id);
      expect(uploadId).toEqual(expect.any(String));
      const parts = await context.storage.listAllParts(
        videoSourceKey(draft.id),
        uploadId!,
      );
      expect(parts?.map((part) => part.partNumber)).toEqual([1]);
      await expect(queueDepth(sqs)).resolves.toEqual({
        visible: 0,
        inFlight: 0,
      });
    },
    E2E_TIMEOUT_MS,
  );

  it(
    'reject-mismatched-etag',
    async () => {
      const draft = await createUploadedDraft();

      const rejected = await complete(draft.id, userA.token)
        .send({ parts: [{ partNumber: 1, etag: '"different-etag"' }] })
        .expect(409);

      expect(rejected.body).toMatchObject({ error: 'UPLOAD_INCOMPLETE' });
      const video = await context.videos.findOneByOrFail({ id: draft.id });
      expect(video.status).toBe(VideoStatus.DRAFT);

      await complete(draft.id, userA.token)
        .send({ parts: draft.parts })
        .expect(202);
    },
    E2E_TIMEOUT_MS,
  );

  it(
    'fail-on-final-size-mismatch',
    async () => {
      const draft = await createUploadedDraft();
      const key = videoSourceKey(draft.id);
      await completeMultipartDirectly(draft);
      await context.storage.putObject(key, Buffer.alloc(512, 'x'));
      await expect(context.storage.headObject(key)).resolves.toEqual({
        contentLength: 512,
      });

      const response = await complete(draft.id, userA.token)
        .send({ parts: draft.parts })
        .expect(422);

      expect(response.body).toMatchObject({ error: 'VIDEO_SIZE_MISMATCH' });
      const video = await context.videos.findOneByOrFail({ id: draft.id });
      expect(video.status).toBe(VideoStatus.FAILED);
      expect(video.failure_code).toBe('SIZE_MISMATCH');
      expect(video.storage_purged_at).toBeInstanceOf(Date);
      await expect(context.storage.headObject(key)).resolves.toBeNull();
      await expect(queueDepth(sqs)).resolves.toEqual({
        visible: 0,
        inFlight: 0,
      });
    },
    E2E_TIMEOUT_MS,
  );

  // 3. POST /videos/:id/upload/complete — contrato da requisição

  it(
    'reject-invalid-complete-request',
    async () => {
      const draft = await createDraft(context, userA.token, 1024);
      const validPart = { partNumber: 1, etag: '"etag"' };
      const invalidBodies: unknown[] = [
        {},
        { parts: [] },
        {
          parts: Array.from({ length: 641 }, (_, index) => ({
            partNumber: index + 1,
            etag: '"etag"',
          })),
        },
        { parts: [validPart, validPart] },
        { parts: [{ partNumber: 0, etag: '"etag"' }] },
        { parts: [{ partNumber: 1, etag: '' }] },
        { parts: [validPart], extra: true },
      ];

      for (const body of invalidBodies) {
        await complete(draft.id, userA.token)
          .send(body as object)
          .expect(400);
      }

      const video = await context.videos.findOneByOrFail({ id: draft.id });
      expect(video.status).toBe(VideoStatus.DRAFT);
      await complete('not-a-uuid', userA.token)
        .send({ parts: [validPart] })
        .expect(400);
    },
    E2E_TIMEOUT_MS,
  );

  it(
    'reject-complete-without-token',
    async () => {
      const draft = await createUploadedDraft();

      await complete(draft.id).send({ parts: draft.parts }).expect(401);
      await complete(draft.id, 'malformed-token')
        .send({ parts: draft.parts })
        .expect(401);

      const video = await context.videos.findOneByOrFail({ id: draft.id });
      expect(video.status).toBe(VideoStatus.DRAFT);
      await expect(queueDepth(sqs)).resolves.toEqual({
        visible: 0,
        inFlight: 0,
      });
    },
    E2E_TIMEOUT_MS,
  );

  // 4. POST /videos/:id/upload/complete — erros de domínio

  it(
    'hide-video-from-other-channel',
    async () => {
      const draft = await createUploadedDraft();

      const fromOtherUser = await complete(draft.id, userB.token)
        .send({ parts: draft.parts })
        .expect(404);

      expect(fromOtherUser.body).toMatchObject({ error: 'VIDEO_NOT_FOUND' });
      const video = await context.videos.findOneByOrFail({ id: draft.id });
      expect(video.status).toBe(VideoStatus.DRAFT);
      await expect(queueDepth(sqs)).resolves.toEqual({
        visible: 0,
        inFlight: 0,
      });

      const unknown = await complete(randomUUID(), userA.token)
        .send({ parts: draft.parts })
        .expect(404);
      expect(unknown.body).toMatchObject({ error: 'VIDEO_NOT_FOUND' });
    },
    E2E_TIMEOUT_MS,
  );

  it(
    'reject-expired-upload',
    async () => {
      const draft = await createUploadedDraft();
      await context.videos.update(draft.id, {
        upload_expires_at: new Date(Date.now() - 60_000),
      });

      const response = await complete(draft.id, userA.token)
        .send({ parts: draft.parts })
        .expect(410);

      expect(response.body).toMatchObject({ error: 'UPLOAD_EXPIRED' });
      const video = await context.videos.findOneByOrFail({ id: draft.id });
      expect(video.status).toBe(VideoStatus.DRAFT);
      await expect(queueDepth(sqs)).resolves.toEqual({
        visible: 0,
        inFlight: 0,
      });
    },
    E2E_TIMEOUT_MS,
  );

  it(
    'reject-failed-video',
    async () => {
      const draft = await createDraft(context, userA.token, 1024);
      const key = videoSourceKey(draft.id);
      const uploadId = await readUploadId(context, draft.id);
      await context.storage.abortMultipartUpload(key, uploadId!);
      await context.videos.update(draft.id, { status: VideoStatus.FAILED });

      const response = await complete(draft.id, userA.token)
        .send({ parts: [{ partNumber: 1, etag: '"etag"' }] })
        .expect(409);

      expect(response.body).toMatchObject({ error: 'UPLOAD_NOT_ACTIVE' });
      await expect(queueDepth(sqs)).resolves.toEqual({
        visible: 0,
        inFlight: 0,
      });
    },
    E2E_TIMEOUT_MS,
  );
});
