import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { videoSourceKey } from '../src/storage/storage-keys';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { signedRequest } from '../src/test/signed-request';
import { VideoStatus } from '../src/videos/entities/video-status.enum';
import {
  cleanVideoStorage,
  createDraft,
  createVideoE2eContext,
  E2E_TIMEOUT_MS,
  readUploadId,
  registerConfirmAndLogin,
  signParts,
  type SignedPart,
  type TestUser,
  uploadPart,
  type VideoE2eContext,
} from './support/video-e2e';

describe('videos-upload-parts', () => {
  let context: VideoE2eContext;
  let userA: TestUser;
  let userB: TestUser;

  const withToken = <T extends request.Test>(call: T, token?: string): T =>
    token ? call.set('Authorization', `Bearer ${token}`) : call;
  const postPartUrls = (id: string, token?: string) =>
    withToken(
      request(context.app.getHttpServer()).post(
        `/videos/${id}/upload/part-urls`,
      ),
      token,
    );
  const getParts = (id: string, token?: string) =>
    withToken(
      request(context.app.getHttpServer()).get(`/videos/${id}/upload/parts`),
      token,
    );

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
      `parts_a_${randomUUID()}@example.com`,
    );
    userB = await registerConfirmAndLogin(
      context,
      `parts_b_${randomUUID()}@example.com`,
    );
  }, E2E_TIMEOUT_MS);

  afterEach(async () => {
    await cleanVideoStorage(context);
  }, E2E_TIMEOUT_MS);

  // 1. POST /videos/:id/upload/part-urls — assinatura de partes

  it(
    'sign-upload-part-urls',
    async () => {
      const draft = await createDraft(context, userA.token, 40_000_000);
      expect(draft.partCount).toBe(3);
      const startedAt = Date.now();

      const response = await postPartUrls(draft.id, userA.token)
        .send({ partNumbers: [1, 2, 3] })
        .expect(201);

      const body = response.body as { parts: SignedPart[]; expiresAt: string };
      expect(body.parts).toHaveLength(3);
      expect(
        Math.abs(
          new Date(body.expiresAt).getTime() - startedAt - 60 * 60 * 1000,
        ),
      ).toBeLessThan(60_000);
      for (const part of body.parts) {
        const url = new URL(part.url);
        const parameters = [...url.searchParams.keys()].map((name) =>
          name.toLowerCase(),
        );
        expect(url.host).toBe('localhost:9000');
        expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain(
          'content-length',
        );
        expect(
          parameters.filter(
            (name) =>
              name.startsWith('x-amz-checksum') ||
              name === 'x-amz-sdk-checksum-algorithm',
          ),
        ).toEqual([]);
      }
    },
    E2E_TIMEOUT_MS,
  );

  it(
    'sign-maximum-batch-of-50-parts',
    async () => {
      const draft = await createDraft(context, userA.token, 838_860_800);
      expect(draft.partCount).toBe(50);
      const partNumbers = Array.from({ length: 50 }, (_, index) => index + 1);

      const parts = await signParts(
        context,
        userA.token,
        draft.id,
        partNumbers,
      );

      expect(parts.map((part) => part.partNumber)).toEqual(partNumbers);
      expect(parts.every((part) => part.contentLength === 16_777_216)).toBe(
        true,
      );
    },
    E2E_TIMEOUT_MS,
  );

  it(
    'calculate-last-part-content-length',
    async () => {
      const large = await createDraft(context, userA.token, 40_000_000);
      const [second, third] = await signParts(
        context,
        userA.token,
        large.id,
        [2, 3],
      );
      expect(second.contentLength).toBe(16_777_216);
      expect(third.contentLength).toBe(6_445_568);

      const small = await createDraft(context, userA.token, 1024);
      const [part] = await signParts(context, userA.token, small.id, [1]);
      expect(part.contentLength).toBe(1024);

      const rejected = await signedRequest(part.url, {
        method: 'PUT',
        body: Buffer.alloc(1023, 'a'),
      });
      expect(rejected.status).toBe(403);

      const accepted = await signedRequest(part.url, {
        method: 'PUT',
        body: Buffer.alloc(1024, 'a'),
      });
      expect(accepted.status).toBe(200);
      expect(accepted.headers.etag).toEqual(expect.any(String));
    },
    E2E_TIMEOUT_MS,
  );

  // 2. GET /videos/:id/upload/parts — retomada

  it(
    'list-uploaded-parts',
    async () => {
      const draft = await createDraft(context, userA.token, 1024);

      const before = await getParts(draft.id, userA.token).expect(200);
      expect(before.body).toMatchObject({
        partSizeBytes: draft.partSizeBytes,
        partCount: draft.partCount,
        uploadExpiresAt: draft.uploadExpiresAt,
        parts: [],
      });

      const etag = await uploadPart(
        context,
        userA.token,
        draft.id,
        1,
        Buffer.alloc(1024, 'b'),
      );

      const after = await getParts(draft.id, userA.token).expect(200);
      expect((after.body as { parts: unknown[] }).parts).toEqual([
        { partNumber: 1, sizeBytes: 1024, etag },
      ]);
    },
    E2E_TIMEOUT_MS,
  );

  // 3. Upload parts — contrato da requisição

  it(
    'reject-invalid-sign-request',
    async () => {
      const draft = await createDraft(context, userA.token, 838_860_800);
      const invalidBodies: unknown[] = [
        { partNumbers: Array.from({ length: 51 }, (_, index) => index + 1) },
        {},
        { partNumbers: [] },
        { partNumbers: [1, 1] },
        { partNumbers: [0] },
        { partNumbers: [-1] },
        { partNumbers: [1.5] },
        { partNumbers: ['1'] },
        { partNumbers: [1], extra: true },
      ];

      for (const body of invalidBodies) {
        await postPartUrls(draft.id, userA.token)
          .send(body as object)
          .expect(400);
      }

      await postPartUrls('not-a-uuid', userA.token)
        .send({ partNumbers: [1] })
        .expect(400);
      await getParts('not-a-uuid', userA.token).expect(400);
    },
    E2E_TIMEOUT_MS,
  );

  it(
    'reject-part-number-above-part-count',
    async () => {
      const draft = await createDraft(context, userA.token, 40_000_000);

      const response = await postPartUrls(draft.id, userA.token)
        .send({ partNumbers: [1, 4] })
        .expect(400);

      expect(response.body).toMatchObject({ error: 'INVALID_PART_NUMBER' });
      expect(response.body).not.toHaveProperty('parts');
    },
    E2E_TIMEOUT_MS,
  );

  it(
    'reject-upload-routes-without-token',
    async () => {
      const draft = await createDraft(context, userA.token, 1024);

      await postPartUrls(draft.id)
        .send({ partNumbers: [1] })
        .expect(401);
      await getParts(draft.id).expect(401);
      await postPartUrls(draft.id, 'malformed-token')
        .send({ partNumbers: [1] })
        .expect(401);
      await getParts(draft.id, 'malformed-token').expect(401);
    },
    E2E_TIMEOUT_MS,
  );

  // 4. Upload parts — erros de domínio

  it(
    'hide-video-from-other-channel',
    async () => {
      const draft = await createDraft(context, userA.token, 1024);

      for (const [id, token] of [
        [draft.id, userB.token],
        [randomUUID(), userA.token],
      ]) {
        const signed = await postPartUrls(id, token)
          .send({ partNumbers: [1] })
          .expect(404);
        const listed = await getParts(id, token).expect(404);

        for (const response of [signed, listed]) {
          expect(response.body).toMatchObject({ error: 'VIDEO_NOT_FOUND' });
          expect(response.body).not.toHaveProperty('parts');
        }
      }
    },
    E2E_TIMEOUT_MS,
  );

  it(
    'reject-expired-upload-session',
    async () => {
      const draft = await createDraft(context, userA.token, 1024);
      await context.videos.update(draft.id, {
        upload_expires_at: new Date(Date.now() - 60_000),
      });
      const video = await context.videos.findOneByOrFail({ id: draft.id });
      expect(video.status).toBe(VideoStatus.DRAFT);

      const signed = await postPartUrls(draft.id, userA.token)
        .send({ partNumbers: [1] })
        .expect(410);
      const listed = await getParts(draft.id, userA.token).expect(410);

      expect(signed.body).toMatchObject({ error: 'UPLOAD_EXPIRED' });
      expect(listed.body).toMatchObject({ error: 'UPLOAD_EXPIRED' });
    },
    E2E_TIMEOUT_MS,
  );

  it(
    'reject-upload-not-active',
    async () => {
      const draft = await createDraft(context, userA.token, 1024);
      const key = videoSourceKey(draft.id);
      const uploadId = await readUploadId(context, draft.id);
      await context.storage.abortMultipartUpload(key, uploadId!);
      await expect(
        context.storage.listAllParts(key, uploadId!),
      ).resolves.toBeNull();

      for (const status of [
        VideoStatus.PROCESSING,
        VideoStatus.READY,
        VideoStatus.FAILED,
      ]) {
        await context.videos.update(draft.id, { status });

        const signed = await postPartUrls(draft.id, userA.token)
          .send({ partNumbers: [1] })
          .expect(409);
        const listed = await getParts(draft.id, userA.token).expect(409);

        expect(signed.body).toMatchObject({ error: 'UPLOAD_NOT_ACTIVE' });
        expect(listed.body).toMatchObject({ error: 'UPLOAD_NOT_ACTIVE' });
      }
    },
    E2E_TIMEOUT_MS,
  );
});
