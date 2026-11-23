import { randomUUID } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { signedRequest } from '../test/signed-request';
import { videoSourceKey } from './storage-keys';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

const TEST_TIMEOUT_MS = 30_000;

describe('StorageService (integration)', () => {
  let moduleRef: TestingModule;
  let storage: StorageService;
  let key: string;
  let uploadId: string | undefined;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();
    storage = moduleRef.get(StorageService);
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(() => {
    key = videoSourceKey(randomUUID());
    uploadId = undefined;
  });

  afterEach(async () => {
    if (uploadId) await storage.abortMultipartUpload(key, uploadId);
    await storage.deleteObject(key);
  }, TEST_TIMEOUT_MS);

  async function uploadPart(
    partNumber: number,
    content: Buffer,
  ): Promise<string> {
    const url = await storage.signUploadPart(
      key,
      uploadId!,
      partNumber,
      content.length,
    );
    const response = await signedRequest(url, {
      method: 'PUT',
      body: content,
    });
    expect(response.status).toBe(200);
    return response.headers.etag as string;
  }

  it(
    'should complete a multipart upload through signed part URLs',
    async () => {
      uploadId = await storage.createMultipartUpload(key);
      const content = Buffer.alloc(1024, 'a');
      const etag = await uploadPart(1, content);

      const parts = await storage.listAllParts(key, uploadId);
      expect(parts).toEqual([{ partNumber: 1, sizeBytes: 1024, etag }]);

      await expect(
        storage.completeMultipartUpload(key, uploadId, [
          { partNumber: 1, etag },
        ]),
      ).resolves.toBe(true);
      uploadId = undefined;

      await expect(storage.headObject(key)).resolves.toEqual({
        contentLength: 1024,
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'should list every part across pages',
    async () => {
      uploadId = await storage.createMultipartUpload(key);
      for (const partNumber of [1, 2, 3]) {
        await uploadPart(partNumber, Buffer.alloc(16, String(partNumber)));
      }

      const parts = await storage.listAllParts(key, uploadId, 2);

      expect(parts?.map((part) => part.partNumber)).toEqual([1, 2, 3]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'should reject a body that differs from the signed Content-Length',
    async () => {
      uploadId = await storage.createMultipartUpload(key);
      const url = await storage.signUploadPart(key, uploadId, 1, 1024);

      const response = await signedRequest(url, {
        method: 'PUT',
        body: Buffer.alloc(1023, 'a'),
      });

      expect(response.status).toBe(403);
      await expect(storage.listAllParts(key, uploadId)).resolves.toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it('should sign part URLs without automatic checksum parameters', async () => {
    uploadId = await storage.createMultipartUpload(key);

    const url = new URL(await storage.signUploadPart(key, uploadId, 1, 1024));
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
  });

  it(
    'should serve a public URL through the signed public Host',
    async () => {
      await storage.putObject(key, Buffer.from('public-content'), 'video/mp4');

      const url = await storage.signPublicGetObject(key, {
        expiresInSeconds: 60,
      });
      const response = await signedRequest(url);

      expect(new URL(url).host).toBe('localhost:9000');
      expect(response.status).toBe(200);
      expect(response.body.toString()).toBe('public-content');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'should answer a Range request with 206',
    async () => {
      await storage.putObject(key, Buffer.from('0123456789'), 'video/mp4');
      const url = await storage.signPublicGetObject(key, {
        expiresInSeconds: 60,
        responseContentType: 'video/mp4',
        responseContentDisposition: 'inline',
      });

      const response = await signedRequest(url, {
        headers: { Range: 'bytes=2-5' },
      });

      expect(response.status).toBe(206);
      expect(response.headers['content-range']).toBe('bytes 2-5/10');
      expect(response.headers['content-type']).toBe('video/mp4');
      expect(response.headers['content-disposition']).toBe('inline');
      expect(response.body.toString()).toBe('2345');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'should sign an internal URL that the worker can read directly',
    async () => {
      await storage.putObject(key, Buffer.from('internal-content'));

      const url = await storage.signInternalGetObject(key, 60);
      const response = await fetch(url);

      expect(new URL(url).host).toBe('minio:9000');
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('internal-content');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'should allow the frontend origin and expose ETag through CORS',
    async () => {
      uploadId = await storage.createMultipartUpload(key);
      const content = Buffer.alloc(32, 'c');
      const url = await storage.signUploadPart(
        key,
        uploadId,
        1,
        content.length,
      );
      const origin = 'http://localhost:3001';

      const preflight = await signedRequest(url, {
        method: 'OPTIONS',
        headers: {
          Origin: origin,
          'Access-Control-Request-Method': 'PUT',
          'Access-Control-Request-Headers': 'content-type',
        },
      });
      const upload = await signedRequest(url, {
        method: 'PUT',
        body: content,
        headers: { Origin: origin },
      });

      expect(preflight.status).toBeLessThan(300);
      expect(preflight.headers['access-control-allow-origin']).toBe(origin);
      expect(upload.status).toBe(200);
      expect(
        String(upload.headers['access-control-expose-headers']).toLowerCase(),
      ).toContain('etag');
    },
    TEST_TIMEOUT_MS,
  );

  it('should treat missing resources as explicit results', async () => {
    const missingUploadId = 'bWlzc2luZy11cGxvYWQ';

    await expect(storage.headObject(key)).resolves.toBeNull();
    await expect(storage.deleteObject(key)).resolves.toBeUndefined();
    await expect(
      storage.abortMultipartUpload(key, missingUploadId),
    ).resolves.toBeUndefined();
    await expect(
      storage.listAllParts(key, missingUploadId),
    ).resolves.toBeNull();
    await expect(
      storage.completeMultipartUpload(key, missingUploadId, [
        { partNumber: 1, etag: '"missing"' },
      ]),
    ).resolves.toBe(false);
  });
});
