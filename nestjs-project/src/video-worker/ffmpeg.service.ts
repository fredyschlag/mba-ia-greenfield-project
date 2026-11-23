import { spawn } from 'node:child_process';
import { Injectable } from '@nestjs/common';
import { parseEbmlDocType } from './ebml-doc-type';
import { MediaToolError, MediaUnreadableError } from './media.errors';
import { isMatroskaFamily, isMp4Family } from './media-allowlist';
import {
  EBML_HEADER_READ_BYTES,
  EBML_HEADER_TIMEOUT_MS,
  FFMPEG_FORMAT_WHITELIST,
  FFMPEG_IO_TIMEOUT_MICROSECONDS,
  FFMPEG_PROTOCOL_WHITELIST,
  FFMPEG_RECONNECT_DELAY_MAX_SECONDS,
  FFMPEG_STDERR_TAIL_BYTES,
  FFMPEG_THUMBNAIL_MAX_BYTES,
  FFMPEG_THUMBNAIL_TIMEOUT_MS,
  FFPROBE_MAX_OUTPUT_BYTES,
  FFPROBE_TIMEOUT_MS,
  MEDIA_ERROR_DETAIL_LENGTH,
  THUMBNAIL_JPEG_QUALITY,
  THUMBNAIL_POSITION_RATIO,
} from './video-worker.constants';

export interface MediaProbe {
  durationSeconds: number;
  width: number;
  height: number;
  formatName: string;
  container: string;
  ebmlDocType: string | null;
  videoCodec: string;
  audioCodec: string | null;
  pixelFormat: string;
}

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  pix_fmt?: string;
  width?: number;
  height?: number;
  duration?: string;
  disposition?: { attached_pic?: number };
}

interface ProbeOutput {
  format?: { format_name?: string; duration?: string };
  streams?: ProbeStream[];
}

interface RunOptions {
  timeoutMs: number;
  maxStdoutBytes: number;
  signal?: AbortSignal;
}

interface ProcessResult {
  exitCode: number | null;
  stdout: Buffer;
  stderr: string;
}

const NETWORK_FAILURE =
  /server returned|connection (refused|reset|timed out)|timed out|network is unreachable|temporary failure|failed to resolve|i\/o error|broken pipe/i;
const UNREADABLE_MEDIA =
  /invalid data found|moov atom not found|not on whitelist|could not find codec parameters|does not contain any stream|output file is empty/i;

export function redactMediaUrls(text: string): string {
  return text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/gi, '[redacted-url]')
    .replace(/X-Amz-[A-Za-z-]+=[^&\s'"]+/g, '[redacted]');
}

@Injectable()
export class FfmpegService {
  async probe(url: string, signal?: AbortSignal): Promise<MediaProbe> {
    const result = await this.run(
      'ffprobe',
      [
        '-v',
        'error',
        ...this.inputOptions(),
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        '-i',
        url,
      ],
      {
        timeoutMs: FFPROBE_TIMEOUT_MS,
        maxStdoutBytes: FFPROBE_MAX_OUTPUT_BYTES,
        signal,
      },
    );
    if (result.exitCode !== 0) {
      throw this.classifyFailure('ffprobe', result.stderr);
    }

    const output = this.parseProbeOutput(result.stdout);
    const formatName = output.format?.format_name;
    const streams = output.streams ?? [];
    const video = streams.find(
      (stream) =>
        stream.codec_type === 'video' && !stream.disposition?.attached_pic,
    );
    if (!formatName || !video?.codec_name || !video.pix_fmt) {
      throw new MediaUnreadableError('The file has no readable video stream');
    }

    const durationSeconds = Number(output.format?.duration ?? video.duration);
    const width = video.width ?? 0;
    const height = video.height ?? 0;
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new MediaUnreadableError('The file has no readable duration');
    }
    if (width <= 0 || height <= 0) {
      throw new MediaUnreadableError('The file has no readable dimensions');
    }

    const ebmlDocType = isMatroskaFamily(formatName)
      ? await this.readEbmlDocType(url, signal)
      : null;
    const audio = streams.find((stream) => stream.codec_type === 'audio');

    return {
      durationSeconds,
      width,
      height,
      formatName,
      container: this.containerName(formatName, ebmlDocType),
      ebmlDocType,
      videoCodec: video.codec_name,
      audioCodec: audio?.codec_name ?? null,
      pixelFormat: video.pix_fmt,
    };
  }

  async extractThumbnail(
    url: string,
    durationSeconds: number,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    const position = durationSeconds * THUMBNAIL_POSITION_RATIO;
    if (position > 0) {
      const frame = await this.extractFrame(url, position, signal);
      if (frame) {
        return frame;
      }
    }

    const firstFrame = await this.extractFrame(url, null, signal);
    if (!firstFrame) {
      throw new MediaUnreadableError('No video frame could be decoded');
    }
    return firstFrame;
  }

  private async extractFrame(
    url: string,
    positionSeconds: number | null,
    signal?: AbortSignal,
  ): Promise<Buffer | null> {
    const seek =
      positionSeconds === null ? [] : ['-ss', positionSeconds.toFixed(3)];
    const result = await this.run(
      'ffmpeg',
      [
        '-nostdin',
        '-v',
        'error',
        ...this.inputOptions(),
        ...seek,
        '-i',
        url,
        '-map',
        '0:V:0',
        '-an',
        '-sn',
        '-dn',
        '-frames:v',
        '1',
        '-c:v',
        'mjpeg',
        '-q:v',
        THUMBNAIL_JPEG_QUALITY,
        '-pix_fmt',
        'yuvj420p',
        '-f',
        'image2pipe',
        'pipe:1',
      ],
      {
        timeoutMs: FFMPEG_THUMBNAIL_TIMEOUT_MS,
        maxStdoutBytes: FFMPEG_THUMBNAIL_MAX_BYTES,
        signal,
      },
    );

    if (result.exitCode !== 0) {
      const failure = this.classifyFailure('ffmpeg', result.stderr);
      if (failure instanceof MediaToolError) {
        throw failure;
      }
      return null;
    }
    return this.isJpeg(result.stdout) ? result.stdout : null;
  }

  private inputOptions(): string[] {
    return [
      '-protocol_whitelist',
      FFMPEG_PROTOCOL_WHITELIST,
      '-format_whitelist',
      FFMPEG_FORMAT_WHITELIST,
      '-rw_timeout',
      String(FFMPEG_IO_TIMEOUT_MICROSECONDS),
      '-reconnect',
      '1',
      '-reconnect_on_network_error',
      '1',
      '-reconnect_delay_max',
      String(FFMPEG_RECONNECT_DELAY_MAX_SECONDS),
    ];
  }

  private containerName(
    formatName: string,
    ebmlDocType: string | null,
  ): string {
    if (isMp4Family(formatName)) {
      return 'mp4';
    }
    return ebmlDocType ?? formatName;
  }

  private parseProbeOutput(stdout: Buffer): ProbeOutput {
    try {
      return JSON.parse(stdout.toString('utf8')) as ProbeOutput;
    } catch {
      throw new MediaToolError('ffprobe returned an invalid response');
    }
  }

  private isJpeg(buffer: Buffer): boolean {
    return (
      buffer.length > 3 &&
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[2] === 0xff
    );
  }

  private classifyFailure(
    command: string,
    stderr: string,
  ): MediaToolError | MediaUnreadableError {
    const detail = redactMediaUrls(stderr)
      .trim()
      .slice(-MEDIA_ERROR_DETAIL_LENGTH);
    const message = `${command} failed: ${detail}`;
    if (NETWORK_FAILURE.test(stderr)) {
      return new MediaToolError(message);
    }
    // An unknown failure stays retryable, so an infrastructure problem is
    // never reported to the owner as an invalid file.
    return UNREADABLE_MEDIA.test(stderr)
      ? new MediaUnreadableError(message)
      : new MediaToolError(message);
  }

  private async readEbmlDocType(
    url: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const timeout = AbortSignal.timeout(EBML_HEADER_TIMEOUT_MS);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;

    try {
      const response = await fetch(url, {
        headers: { Range: `bytes=0-${EBML_HEADER_READ_BYTES - 1}` },
        signal: requestSignal,
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new MediaToolError(
          `Could not read the file header: HTTP ${response.status}`,
        );
      }
      return parseEbmlDocType(await this.readPrefix(response.body));
    } catch (error) {
      if (error instanceof MediaToolError) {
        throw error;
      }
      throw new MediaToolError('Could not read the file header');
    }
  }

  // The prefix is read manually because a server that ignores Range would
  // otherwise stream the whole object into memory.
  private async readPrefix(body: ReadableStream<Uint8Array>): Promise<Buffer> {
    const reader = body.getReader();
    const chunks: Buffer[] = [];
    let received = 0;
    try {
      while (received < EBML_HEADER_READ_BYTES) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        chunks.push(Buffer.from(value));
        received += value.length;
      }
    } finally {
      await reader.cancel();
    }
    return Buffer.concat(chunks).subarray(0, EBML_HEADER_READ_BYTES);
  }

  private run(
    command: 'ffprobe' | 'ffmpeg',
    args: string[],
    options: RunOptions,
  ): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(new MediaToolError(`${command} was aborted`));
        return;
      }

      const child = spawn(command, args, {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      let stdoutBytes = 0;
      let stderr = '';
      let settled = false;

      const cleanup = (): void => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
      };
      const fail = (error: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        child.kill('SIGKILL');
        reject(error);
      };
      const onAbort = (): void => {
        fail(new MediaToolError(`${command} was aborted`));
      };
      const timer = setTimeout(() => {
        fail(new MediaToolError(`${command} timed out`));
      }, options.timeoutMs);

      options.signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > options.maxStdoutBytes) {
          fail(new MediaUnreadableError(`${command} output is too large`));
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString('utf8')}`.slice(
          -FFMPEG_STDERR_TAIL_BYTES,
        );
      });
      child.on('error', () => {
        fail(new MediaToolError(`${command} could not be started`));
      });
      child.on('close', (exitCode) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve({ exitCode, stdout: Buffer.concat(stdout), stderr });
      });
    });
  }
}
