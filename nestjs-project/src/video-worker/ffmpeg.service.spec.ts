import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { parseEbmlDocType } from './ebml-doc-type';
import { FfmpegService, redactMediaUrls } from './ffmpeg.service';
import { MediaToolError, MediaUnreadableError } from './media.errors';
import {
  FFMPEG_THUMBNAIL_MAX_BYTES,
  FFPROBE_TIMEOUT_MS,
} from './video-worker.constants';

jest.mock('node:child_process', () => ({ spawn: jest.fn() }));

const SIGNED_URL =
  'http://minio:9000/bucket/videos/id/source?X-Amz-Credential=key&X-Amz-Signature=super-secret';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);

interface FakeProcess extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: jest.Mock;
}

const spawnMock = spawn as unknown as jest.Mock;

function pendingProcess(): FakeProcess {
  return Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: jest.fn(),
  });
}

function finishedProcess(
  result: { stdout?: Buffer | string; stderr?: string; code?: number } = {},
): FakeProcess {
  const child = pendingProcess();
  setImmediate(() => {
    if (result.stdout) child.stdout.emit('data', Buffer.from(result.stdout));
    if (result.stderr) child.stderr.emit('data', Buffer.from(result.stderr));
    child.emit('close', result.code ?? 0);
  });
  return child;
}

function probeJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '12.500' },
    streams: [
      {
        codec_type: 'video',
        codec_name: 'h264',
        pix_fmt: 'yuv420p',
        width: 1280,
        height: 720,
      },
      { codec_type: 'audio', codec_name: 'aac' },
    ],
    ...overrides,
  });
}

function spawnArgs(call = 0): string[] {
  return (spawnMock.mock.calls as [string, string[]][])[call][1];
}

function ebmlHeader(docType: string): Buffer {
  const name = Buffer.from(docType, 'ascii');
  const element = Buffer.concat([
    Buffer.from([0x42, 0x82, 0x80 | name.length]),
    name,
  ]);
  return Buffer.concat([
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x80 | element.length]),
    element,
  ]);
}

describe('FfmpegService', () => {
  let service: FfmpegService;

  beforeEach(() => {
    spawnMock.mockReset();
    service = new FfmpegService();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  describe('probe', () => {
    it('should run ffprobe without a shell and with restricted inputs', async () => {
      spawnMock.mockReturnValue(finishedProcess({ stdout: probeJson() }));

      await service.probe(SIGNED_URL);

      expect(spawnMock).toHaveBeenCalledWith(
        'ffprobe',
        expect.any(Array),
        expect.objectContaining({ shell: false }),
      );
      const args = spawnArgs();
      expect(args[args.indexOf('-protocol_whitelist') + 1]).toBe(
        'http,https,tcp,tls',
      );
      expect(args[args.indexOf('-format_whitelist') + 1]).not.toContain('hls');
      expect(args).toContain('-rw_timeout');
      expect(args).not.toContain('-reconnect_max_retries');
      expect(args.indexOf('-protocol_whitelist')).toBeLessThan(
        args.indexOf('-i'),
      );
      expect(args[args.indexOf('-i') + 1]).toBe(SIGNED_URL);
    });

    it('should return the extracted metadata', async () => {
      spawnMock.mockReturnValue(finishedProcess({ stdout: probeJson() }));

      await expect(service.probe(SIGNED_URL)).resolves.toEqual({
        durationSeconds: 12.5,
        width: 1280,
        height: 720,
        formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
        container: 'mp4',
        ebmlDocType: null,
        videoCodec: 'h264',
        audioCodec: 'aac',
        pixelFormat: 'yuv420p',
      });
    });

    it('should ignore cover art when selecting the video stream', async () => {
      const stdout = probeJson({
        streams: [
          {
            codec_type: 'video',
            codec_name: 'mjpeg',
            pix_fmt: 'yuvj420p',
            width: 100,
            height: 100,
            disposition: { attached_pic: 1 },
          },
          {
            codec_type: 'video',
            codec_name: 'h264',
            pix_fmt: 'yuv420p',
            width: 640,
            height: 360,
          },
        ],
      });
      spawnMock.mockReturnValue(finishedProcess({ stdout }));

      const media = await service.probe(SIGNED_URL);

      expect(media.videoCodec).toBe('h264');
      expect(media.audioCodec).toBeNull();
    });

    it('should read the EBML DocType only for Matroska files', async () => {
      const fetchSpy = jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(
          new Response(new Uint8Array(ebmlHeader('webm')), { status: 206 }),
        );
      spawnMock.mockReturnValue(
        finishedProcess({
          stdout: probeJson({
            format: { format_name: 'matroska,webm', duration: '2.0' },
          }),
        }),
      );

      const media = await service.probe(SIGNED_URL);

      expect(media.ebmlDocType).toBe('webm');
      expect(media.container).toBe('webm');
      expect(fetchSpy).toHaveBeenCalledWith(
        SIGNED_URL,
        expect.objectContaining({
          headers: { Range: 'bytes=0-4095' },
        }),
      );
    });

    it('should treat a failed header read as retryable without exposing the URL', async () => {
      jest
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(new Error(`failed ${SIGNED_URL}`));
      spawnMock.mockReturnValue(
        finishedProcess({
          stdout: probeJson({
            format: { format_name: 'matroska,webm', duration: '2.0' },
          }),
        }),
      );

      const error = await service.probe(SIGNED_URL).catch((e: Error) => e);

      expect(error).toBeInstanceOf(MediaToolError);
      expect((error as Error).message).not.toContain('super-secret');
    });

    it('should classify invalid data as unreadable', async () => {
      spawnMock.mockReturnValue(
        finishedProcess({
          code: 1,
          stderr: `${SIGNED_URL}: Invalid data found when processing input`,
        }),
      );

      await expect(service.probe(SIGNED_URL)).rejects.toBeInstanceOf(
        MediaUnreadableError,
      );
    });

    it.each([
      'Server returned 5XX Server Error reply',
      'Server returned 403 Forbidden (access denied)',
      'Connection refused',
      'Connection timed out',
      'an unknown failure',
    ])('should classify "%s" as retryable', async (stderr) => {
      spawnMock.mockReturnValue(finishedProcess({ code: 1, stderr }));

      await expect(service.probe(SIGNED_URL)).rejects.toBeInstanceOf(
        MediaToolError,
      );
    });

    it('should prefer a network failure over an invalid data message', async () => {
      spawnMock.mockReturnValue(
        finishedProcess({
          code: 1,
          stderr:
            'Server returned 5XX Server Error reply\nInvalid data found when processing input',
        }),
      );

      await expect(service.probe(SIGNED_URL)).rejects.toBeInstanceOf(
        MediaToolError,
      );
    });

    it('should never expose the signed URL in error messages', async () => {
      spawnMock.mockReturnValue(
        finishedProcess({
          code: 1,
          stderr: `[http @ 0x1] HTTP error for '${SIGNED_URL}'\n${SIGNED_URL}: Server returned 403 Forbidden`,
        }),
      );

      const error = await service.probe(SIGNED_URL).catch((e: Error) => e);

      const { message } = error as Error;
      expect(message).toContain('403');
      expect(message).not.toContain('super-secret');
      expect(message).not.toContain('X-Amz-Credential');
      expect(message).not.toContain('minio:9000');
    });

    it.each([
      ['no video stream', { streams: [{ codec_type: 'audio' }] }],
      [
        'no duration',
        { format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: 'N/A' } },
      ],
      [
        'no dimensions',
        {
          streams: [
            {
              codec_type: 'video',
              codec_name: 'h264',
              pix_fmt: 'yuv420p',
              width: 0,
              height: 0,
            },
          ],
        },
      ],
    ])('should classify a file with %s as unreadable', async (_, overrides) => {
      spawnMock.mockReturnValue(
        finishedProcess({ stdout: probeJson(overrides) }),
      );

      await expect(service.probe(SIGNED_URL)).rejects.toBeInstanceOf(
        MediaUnreadableError,
      );
    });

    it('should treat an invalid ffprobe response as retryable', async () => {
      spawnMock.mockReturnValue(finishedProcess({ stdout: 'not-json' }));

      await expect(service.probe(SIGNED_URL)).rejects.toBeInstanceOf(
        MediaToolError,
      );
    });

    it('should kill the process and fail as retryable on timeout', async () => {
      jest.useFakeTimers();
      const child = pendingProcess();
      spawnMock.mockReturnValue(child);

      const result = service.probe(SIGNED_URL);
      jest.advanceTimersByTime(FFPROBE_TIMEOUT_MS);

      await expect(result).rejects.toBeInstanceOf(MediaToolError);
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    });

    it('should kill the process when the signal is aborted', async () => {
      const child = pendingProcess();
      spawnMock.mockReturnValue(child);
      const controller = new AbortController();

      const result = service.probe(SIGNED_URL, controller.signal);
      controller.abort();

      await expect(result).rejects.toBeInstanceOf(MediaToolError);
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    });

    it('should not start a process when the signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      await expect(
        service.probe(SIGNED_URL, controller.signal),
      ).rejects.toBeInstanceOf(MediaToolError);
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it('should report a binary that cannot start as retryable', async () => {
      const child = pendingProcess();
      spawnMock.mockReturnValue(child);

      const result = service.probe(SIGNED_URL);
      child.emit('error', new Error(`spawn ffprobe ENOENT ${SIGNED_URL}`));

      const error = await result.catch((e: Error) => e);
      expect(error).toBeInstanceOf(MediaToolError);
      expect((error as Error).message).not.toContain('super-secret');
    });
  });

  describe('extractThumbnail', () => {
    it('should seek before the input to 10% of the duration', async () => {
      spawnMock.mockReturnValue(finishedProcess({ stdout: JPEG }));

      await expect(service.extractThumbnail(SIGNED_URL, 20)).resolves.toEqual(
        JPEG,
      );

      const args = spawnArgs();
      expect(args[args.indexOf('-ss') + 1]).toBe('2.000');
      expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
      expect(args).toContain('-nostdin');
      expect(args[args.indexOf('-protocol_whitelist') + 1]).toBe(
        'http,https,tcp,tls',
      );
      expect(args.at(-1)).toBe('pipe:1');
    });

    it('should fall back to the first frame when no frame is produced', async () => {
      spawnMock
        .mockReturnValueOnce(finishedProcess())
        .mockReturnValueOnce(finishedProcess({ stdout: JPEG }));

      await expect(service.extractThumbnail(SIGNED_URL, 0.04)).resolves.toEqual(
        JPEG,
      );

      expect(spawnMock).toHaveBeenCalledTimes(2);
      expect(spawnArgs(1)).not.toContain('-ss');
    });

    it('should not fall back after a network failure', async () => {
      spawnMock.mockReturnValue(
        finishedProcess({ code: 1, stderr: 'Connection refused' }),
      );

      await expect(
        service.extractThumbnail(SIGNED_URL, 10),
      ).rejects.toBeInstanceOf(MediaToolError);
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });

    it('should be unreadable when no attempt decodes a frame', async () => {
      spawnMock.mockImplementation(() =>
        finishedProcess({
          code: 1,
          stderr: 'Invalid data found when processing input',
        }),
      );

      await expect(
        service.extractThumbnail(SIGNED_URL, 10),
      ).rejects.toBeInstanceOf(MediaUnreadableError);
      expect(spawnMock).toHaveBeenCalledTimes(2);
    });

    it('should stop a process whose output exceeds the limit', async () => {
      const child = pendingProcess();
      spawnMock.mockReturnValue(child);

      const result = service.extractThumbnail(SIGNED_URL, 10);
      child.stdout.emit('data', Buffer.alloc(FFMPEG_THUMBNAIL_MAX_BYTES + 1));

      await expect(result).rejects.toBeInstanceOf(MediaUnreadableError);
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    });
  });

  describe('redactMediaUrls', () => {
    it('should remove URLs and signing parameters', () => {
      const redacted = redactMediaUrls(
        `open ${SIGNED_URL} then X-Amz-Signature=abc&X-Amz-Date=now`,
      );

      expect(redacted).not.toContain('super-secret');
      expect(redacted).not.toContain('abc');
      expect(redacted).toContain('[redacted-url]');
    });
  });

  describe('parseEbmlDocType', () => {
    it.each(['webm', 'matroska'])('should read DocType %s', (docType) => {
      expect(parseEbmlDocType(ebmlHeader(docType))).toBe(docType);
    });

    it('should skip other header elements', () => {
      const header = Buffer.from([
        0x1a, 0x45, 0xdf, 0xa3, 0x8b, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84,
        0x77, 0x65, 0x62, 0x6d,
      ]);

      expect(parseEbmlDocType(header)).toBe('webm');
    });

    it.each([
      ['a non-EBML file', Buffer.from('not an ebml file')],
      ['an empty buffer', Buffer.alloc(0)],
      ['a truncated header', ebmlHeader('webm').subarray(0, 7)],
    ])('should return null for %s', (_, buffer) => {
      expect(parseEbmlDocType(buffer)).toBeNull();
    });
  });
});
