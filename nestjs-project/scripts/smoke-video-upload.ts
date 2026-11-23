/**
 * Manual smoke test of the video pipeline. Run inside the nestjs-api container
 * while the API and the video-worker are running:
 *
 *   npx ts-node scripts/smoke-video-upload.ts <file> [--expect ready|failed]
 *
 * It registers a throwaway user, uploads the file in parts directly to MinIO
 * and follows the video until the expected status.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { basename } from 'node:path';

const API_URL = process.env.SMOKE_API_URL ?? 'http://nestjs-api:3000';
const MAILPIT_URL = process.env.SMOKE_MAILPIT_URL ?? 'http://mailpit:8025';
const STORAGE_HOST = 'minio';
const STORAGE_PORT = 9000;
const PASSWORD = 'smoke-password-123';
const SIGN_BATCH_SIZE = 50;
const UPLOAD_CONCURRENCY = 4;
const UPLOAD_ATTEMPTS = 3;
const POLL_INTERVAL_MS = 2_000;
const PROCESSING_TIMEOUT_MS = 15 * 60 * 1000;
const RANGE_BYTES = 1024;

interface CreatedVideo {
  id: string;
  slug: string;
  partSizeBytes: number;
  partCount: number;
}

interface SignedPart {
  partNumber: number;
  url: string;
  contentLength: number;
}

interface VideoDetails {
  status: string;
  sizeBytes: number | null;
  contentType: string | null;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  thumbnailUrl: string | null;
  failureCode: string | null;
}

interface StorageResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  bytes: number;
  sha256: string;
  head: Buffer;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function api<T>(
  path: string,
  options: { method?: string; token?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${path} answered ${response.status}: ${text}`);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

async function readConfirmationToken(email: string): Promise<string> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const search = await fetch(
      `${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`,
    );
    const { messages } = (await search.json()) as {
      messages: { ID: string }[];
    };
    if (messages.length > 0) {
      const message = await fetch(
        `${MAILPIT_URL}/api/v1/message/${messages[0].ID}`,
      );
      const { Text, HTML } = (await message.json()) as {
        Text: string;
        HTML: string;
      };
      const match = /token=([^"&\s<]+)/.exec(`${Text} ${HTML}`);
      if (match) {
        return match[1];
      }
    }
    await sleep(500);
  }
  throw new Error('Confirmation email not found');
}

async function createUser(): Promise<string> {
  const email = `smoke-${randomUUID()}@example.com`;
  await api('/auth/register', {
    method: 'POST',
    body: { email, password: PASSWORD },
  });
  const token = await readConfirmationToken(email);
  await api(`/auth/confirm-email?token=${encodeURIComponent(token)}`);
  const { access_token: accessToken } = await api<{ access_token: string }>(
    '/auth/login',
    { method: 'POST', body: { email, password: PASSWORD } },
  );
  return accessToken;
}

function putPart(
  url: string,
  file: string,
  start: number,
  length: number,
): Promise<string> {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        hostname: STORAGE_HOST,
        port: STORAGE_PORT,
        method: 'PUT',
        path: `${parsed.pathname}${parsed.search}`,
        headers: { Host: parsed.host, 'Content-Length': String(length) },
      },
      (response) => {
        response.resume();
        response.on('error', reject);
        response.on('end', () => {
          const { etag } = response.headers;
          if (response.statusCode === 200 && etag) {
            resolve(etag);
          } else {
            reject(new Error(`Part upload answered ${response.statusCode}`));
          }
        });
      },
    );
    outgoing.on('error', reject);
    createReadStream(file, { start, end: start + length - 1 })
      .on('error', reject)
      .pipe(outgoing);
  });
}

async function putPartWithRetry(
  part: SignedPart,
  file: string,
  partSize: number,
): Promise<string> {
  const start = (part.partNumber - 1) * partSize;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await putPart(part.url, file, start, part.contentLength);
    } catch (error) {
      if (attempt >= UPLOAD_ATTEMPTS) {
        throw error;
      }
      await sleep(attempt * 1000);
    }
  }
}

async function uploadParts(
  video: CreatedVideo,
  file: string,
  token: string,
): Promise<{ partNumber: number; etag: string }[]> {
  const completed: { partNumber: number; etag: string }[] = [];

  for (let first = 1; first <= video.partCount; first += SIGN_BATCH_SIZE) {
    const last = Math.min(first + SIGN_BATCH_SIZE - 1, video.partCount);
    const partNumbers = Array.from(
      { length: last - first + 1 },
      (_, index) => first + index,
    );
    const { parts } = await api<{ parts: SignedPart[] }>(
      `/videos/${video.id}/upload/part-urls`,
      { method: 'POST', token, body: { partNumbers } },
    );

    const pending = [...parts];
    await Promise.all(
      Array.from({ length: UPLOAD_CONCURRENCY }, async () => {
        for (let part = pending.shift(); part; part = pending.shift()) {
          const etag = await putPartWithRetry(part, file, video.partSizeBytes);
          completed.push({ partNumber: part.partNumber, etag });
        }
      }),
    );
    console.log(`Uploaded ${last}/${video.partCount} parts`);
  }
  return completed.sort((a, b) => a.partNumber - b.partNumber);
}

function storageGet(
  url: string,
  headers: Record<string, string> = {},
): Promise<StorageResponse> {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        hostname: STORAGE_HOST,
        port: STORAGE_PORT,
        path: `${parsed.pathname}${parsed.search}`,
        headers: { Host: parsed.host, ...headers },
      },
      (response) => {
        const hash = createHash('sha256');
        let bytes = 0;
        let head = Buffer.alloc(0);
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          hash.update(chunk);
          if (head.length < RANGE_BYTES) {
            head = Buffer.concat([head, chunk]).subarray(0, RANGE_BYTES);
          }
        });
        response.on('error', reject);
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            bytes,
            sha256: hash.digest('hex'),
            head,
          });
        });
      },
    );
    outgoing.on('error', reject);
    outgoing.end();
  });
}

function fileSha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

async function waitForFinalStatus(
  slug: string,
  token: string,
): Promise<VideoDetails> {
  const deadline = Date.now() + PROCESSING_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const video = await api<VideoDetails>(`/videos/${slug}`, { token });
    if (video.status === 'ready' || video.status === 'failed') {
      return video;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error('Timed out waiting for the video to be processed');
}

function assertSmoke(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Smoke check failed: ${message}`);
  }
  console.log(`OK: ${message}`);
}

async function verifyReadyVideo(
  video: VideoDetails,
  slug: string,
  file: string,
  size: number,
  token: string,
): Promise<void> {
  assertSmoke(video.sizeBytes === size, 'stored size matches the file');
  assertSmoke(Boolean(video.thumbnailUrl), 'thumbnail URL is present');

  const thumbnail = await storageGet(video.thumbnailUrl!);
  assertSmoke(
    thumbnail.status === 200 &&
      thumbnail.head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
    'thumbnail is a JPEG',
  );

  const playback = await api<{ url: string }>(`/videos/${slug}/playback`, {
    token,
  });
  const range = await storageGet(playback.url, {
    Range: `bytes=0-${RANGE_BYTES - 1}`,
  });
  assertSmoke(
    range.status === 206 && range.bytes === RANGE_BYTES,
    'playback answers Range with 206',
  );
  assertSmoke(
    String(range.headers['content-disposition']).startsWith('inline'),
    'playback is served inline',
  );

  const download = await api<{ url: string }>(`/videos/${slug}/download`, {
    token,
  });
  const body = await storageGet(download.url);
  assertSmoke(
    String(body.headers['content-disposition']).startsWith('attachment'),
    'download is served as an attachment',
  );
  assertSmoke(body.bytes === size, 'download has the original size');
  assertSmoke(
    body.sha256 === (await fileSha256(file)),
    'download matches the original SHA-256',
  );
}

async function main(): Promise<void> {
  const [file, flag, expected = 'ready'] = process.argv.slice(2);
  if (!file || (flag !== undefined && flag !== '--expect')) {
    throw new Error('Usage: smoke-video-upload <file> [--expect ready|failed]');
  }

  const size = statSync(file).size;
  const token = await createUser();
  const video = await api<CreatedVideo>('/videos', {
    method: 'POST',
    token,
    body: { filename: basename(file), sizeBytes: size },
  });
  console.log(`Video ${video.id} (${video.slug}): ${video.partCount} part(s)`);

  const startedAt = Date.now();
  const parts = await uploadParts(video, file, token);
  console.log(`Upload took ${Math.round((Date.now() - startedAt) / 1000)}s`);
  await api(`/videos/${video.id}/upload/complete`, {
    method: 'POST',
    token,
    body: { parts },
  });

  const final = await waitForFinalStatus(video.slug, token);
  console.log(JSON.stringify({ id: video.id, slug: video.slug, ...final }));
  assertSmoke(final.status === expected, `video reached ${expected}`);

  if (expected === 'ready') {
    await verifyReadyVideo(final, video.slug, file, size, token);
  } else {
    assertSmoke(final.sizeBytes === size, 'stored size matches the file');
    assertSmoke(
      final.failureCode === 'UNSUPPORTED_FORMAT',
      'failure code is UNSUPPORTED_FORMAT',
    );
  }
  console.log('SMOKE PASSED');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
