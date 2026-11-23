import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { videoSourceKey } from '../storage/storage-keys';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { FfmpegService } from './ffmpeg.service';
import { MediaToolError, MediaUnreadableError } from './media.errors';
import { resolveContentType } from './media-allowlist';

const FIXTURE_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 60_000;
const SIGNED_URL_SECONDS = 300;

const run = promisify(execFile);

const TEST_SOURCES = [
  '-f',
  'lavfi',
  '-i',
  'testsrc2=size=320x180:rate=25:duration=2',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:duration=2',
];
const X264 = ['-c:v', 'libx264', '-preset', 'ultrafast'];
const VP9 = [
  '-c:v',
  'libvpx-vp9',
  '-deadline',
  'realtime',
  '-cpu-used',
  '8',
  '-b:v',
  '200k',
  '-pix_fmt',
  'yuv420p',
];

interface CountingProxy {
  rewrite(url: string): string;
  bytesServed(): number;
  close(): Promise<void>;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

/** Forwards requests to MinIO and counts the bytes actually delivered. */
async function startCountingProxy(): Promise<CountingProxy> {
  let served = 0;
  let upstreamHost = '';

  const server = createServer((incoming, outgoing) => {
    const upstream = request(
      {
        hostname: 'minio',
        port: 9000,
        method: incoming.method,
        path: incoming.url,
        headers: { ...incoming.headers, host: upstreamHost },
      },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.on('data', (chunk: Buffer) => {
          served += chunk.length;
        });
        response.pipe(outgoing);
      },
    );
    upstream.on('error', () => outgoing.destroy());
    outgoing.on('close', () => upstream.destroy());
    incoming.pipe(upstream);
  });
  const port = await listen(server);

  return {
    rewrite(url) {
      const parsed = new URL(url);
      upstreamHost = parsed.host;
      return `http://127.0.0.1:${port}${parsed.pathname}${parsed.search}`;
    },
    bytesServed: () => served,
    close: () => closeServer(server),
  };
}

describe('FfmpegService (integration)', () => {
  let moduleRef: TestingModule;
  let storage: StorageService;
  let service: FfmpegService;
  let workDir: string;
  const uploadedKeys: string[] = [];

  async function encode(name: string, args: string[]): Promise<Buffer> {
    const path = join(workDir, name);
    await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...args, path], {
      maxBuffer: 1024 * 1024,
    });
    return readFile(path);
  }

  async function upload(content: Buffer): Promise<string> {
    const key = videoSourceKey(randomUUID());
    uploadedKeys.push(key);
    await storage.putObject(key, content);
    return storage.signInternalGetObject(key, SIGNED_URL_SECONDS);
  }

  async function dominantColor(
    jpeg: Buffer,
  ): Promise<{ red: number; green: number; blue: number }> {
    const path = join(workDir, `${randomUUID()}.jpg`);
    await writeFile(path, jpeg);
    const { stdout } = await run(
      'ffmpeg',
      [
        '-nostdin',
        '-v',
        'error',
        '-i',
        path,
        '-vf',
        'scale=1:1',
        '-frames:v',
        '1',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        'pipe:1',
      ],
      { encoding: 'buffer' },
    );
    return { red: stdout[0], green: stdout[1], blue: stdout[2] };
  }

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'ffmpeg-service-'));
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
      providers: [FfmpegService],
    }).compile();
    storage = moduleRef.get(StorageService);
    service = moduleRef.get(FfmpegService);
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await Promise.all(uploadedKeys.map((key) => storage.deleteObject(key)));
    await moduleRef.close();
    await rm(workDir, { recursive: true, force: true });
  }, TEST_TIMEOUT_MS);

  it(
    'should read an MP4 with moov at the end without downloading it',
    async () => {
      const content = await encode('moov-at-end.mp4', [
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=1280x720:rate=30:duration=4',
        '-vf',
        'noise=alls=100:allf=t',
        ...X264,
        '-crf',
        '8',
        '-pix_fmt',
        'yuv420p',
      ]);
      expect(content.lastIndexOf('moov')).toBeGreaterThan(
        content.indexOf('mdat'),
      );
      expect(content.length).toBeGreaterThan(10 * 1024 * 1024);

      const proxy = await startCountingProxy();
      try {
        const url = proxy.rewrite(await upload(content));

        const media = await service.probe(url);

        expect(media.durationSeconds).toBeCloseTo(4, 0);
        expect(media.width).toBe(1280);
        expect(media.height).toBe(720);
        expect(media.videoCodec).toBe('h264');
        expect(proxy.bytesServed()).toBeLessThan(content.length / 2);
      } finally {
        await proxy.close();
      }
    },
    FIXTURE_TIMEOUT_MS,
  );

  it(
    'should extract a valid JPEG from 10% of the duration',
    async () => {
      const content = await encode('red-then-blue.mp4', [
        '-filter_complex',
        'color=red:s=160x90:r=25:d=0.5[a];color=blue:s=160x90:r=25:d=9.5[b];[a][b]concat=n=2:v=1[out]',
        '-map',
        '[out]',
        ...X264,
        '-pix_fmt',
        'yuv420p',
      ]);
      const url = await upload(content);
      const media = await service.probe(url);

      const thumbnail = await service.extractThumbnail(
        url,
        media.durationSeconds,
      );

      expect(thumbnail.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
      const color = await dominantColor(thumbnail);
      expect(color.blue).toBeGreaterThan(color.red);
    },
    FIXTURE_TIMEOUT_MS,
  );

  it(
    'should use the first frame of a video too short for the seek',
    async () => {
      const content = await encode('single-frame.mp4', [
        '-f',
        'lavfi',
        '-i',
        'color=green:s=160x90:r=25',
        '-frames:v',
        '1',
        ...X264,
        '-pix_fmt',
        'yuv420p',
      ]);
      const url = await upload(content);
      const media = await service.probe(url);

      const thumbnail = await service.extractThumbnail(
        url,
        media.durationSeconds,
      );

      expect(thumbnail.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
      const color = await dominantColor(thumbnail);
      expect(color.green).toBeGreaterThan(color.blue);
    },
    FIXTURE_TIMEOUT_MS,
  );

  it(
    'should accept MP4 H.264 and AAC in yuvj420p',
    async () => {
      const content = await encode('yuvj.mp4', [
        ...TEST_SOURCES,
        ...X264,
        '-pix_fmt',
        'yuvj420p',
        '-c:a',
        'aac',
      ]);

      const media = await service.probe(await upload(content));

      expect(media.pixelFormat).toBe('yuvj420p');
      expect(media.audioCodec).toBe('aac');
      expect(resolveContentType(media)).toBe('video/mp4');
    },
    FIXTURE_TIMEOUT_MS,
  );

  it(
    'should accept WebM VP9 and Opus',
    async () => {
      const content = await encode('vp9.webm', [
        ...TEST_SOURCES,
        ...VP9,
        '-c:a',
        'libopus',
      ]);

      const media = await service.probe(await upload(content));

      expect(media.ebmlDocType).toBe('webm');
      expect(media.container).toBe('webm');
      expect(resolveContentType(media)).toBe('video/webm');
    },
    FIXTURE_TIMEOUT_MS,
  );

  it(
    'should reject WebM carrying H.264',
    async () => {
      const matroska = await encode('h264.mkv', [
        ...TEST_SOURCES,
        ...X264,
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'libopus',
      ]);
      // The WebM muxer refuses H.264, so the DocType is patched in place and
      // the 4 spare bytes become an EBML Void element.
      const docTypeAt = matroska.indexOf('matroska');
      expect(matroska[docTypeAt - 1]).toBe(0x88);
      Buffer.from([0x84, 0x77, 0x65, 0x62, 0x6d, 0xec, 0x82, 0x00, 0x00]).copy(
        matroska,
        docTypeAt - 1,
      );

      const media = await service.probe(await upload(matroska));

      expect(media.ebmlDocType).toBe('webm');
      expect(media.videoCodec).toBe('h264');
      expect(resolveContentType(media)).toBeNull();
    },
    FIXTURE_TIMEOUT_MS,
  );

  it(
    'should reject H.264 in yuv420p10le',
    async () => {
      const content = await encode('ten-bit.mp4', [
        ...TEST_SOURCES,
        ...X264,
        '-profile:v',
        'high10',
        '-pix_fmt',
        'yuv420p10le',
        '-c:a',
        'aac',
      ]);

      const media = await service.probe(await upload(content));

      expect(media.pixelFormat).toBe('yuv420p10le');
      expect(resolveContentType(media)).toBeNull();
    },
    FIXTURE_TIMEOUT_MS,
  );

  it(
    'should reject MKV with VP9 despite the shared format name',
    async () => {
      const content = await encode('vp9.mkv', [
        ...TEST_SOURCES,
        ...VP9,
        '-c:a',
        'libopus',
      ]);

      const media = await service.probe(await upload(content));

      expect(media.formatName).toBe('matroska,webm');
      expect(media.ebmlDocType).toBe('matroska');
      expect(resolveContentType(media)).toBeNull();
    },
    FIXTURE_TIMEOUT_MS,
  );

  it(
    'should not follow references embedded in an uploaded playlist',
    async () => {
      let hits = 0;
      const target = createServer((_request, response) => {
        hits += 1;
        response.end();
      });
      const port = await listen(target);
      try {
        const playlist = [
          '#EXTM3U',
          '#EXT-X-VERSION:3',
          '#EXT-X-TARGETDURATION:1',
          '#EXTINF:1.0,',
          `http://127.0.0.1:${port}/segment.ts`,
          '#EXTINF:1.0,',
          'file:///etc/hostname',
          '#EXT-X-ENDLIST',
          '',
        ].join('\n');
        const url = await upload(Buffer.from(playlist));

        await expect(service.probe(url)).rejects.toBeInstanceOf(
          MediaUnreadableError,
        );
        await expect(service.extractThumbnail(url, 2)).rejects.toBeInstanceOf(
          MediaUnreadableError,
        );

        expect(hits).toBe(0);
      } finally {
        await closeServer(target);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'should classify random bytes as unreadable',
    async () => {
      const url = await upload(randomBytes(64 * 1024));

      await expect(service.probe(url)).rejects.toBeInstanceOf(
        MediaUnreadableError,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'should keep the signature out of errors for a missing object',
    async () => {
      const url = await storage.signInternalGetObject(
        videoSourceKey(randomUUID()),
        SIGNED_URL_SECONDS,
      );
      const signature = new URL(url).searchParams.get('X-Amz-Signature');

      const error = await service.probe(url).catch((e: Error) => e);

      expect(error).toBeInstanceOf(MediaToolError);
      expect((error as Error).message).not.toContain(signature);
      expect((error as Error).message).not.toContain('X-Amz-');
    },
    TEST_TIMEOUT_MS,
  );
});
