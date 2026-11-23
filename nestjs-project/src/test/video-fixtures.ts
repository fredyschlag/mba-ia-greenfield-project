import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { DataSource } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { User } from '../users/entities/user.entity';
import { VideoStatus } from '../videos/entities/video-status.enum';
import { Video } from '../videos/entities/video.entity';
import { generateVideoSlug } from '../videos/video-slug.util';
import { VIDEO_PART_SIZE_BYTES } from '../videos/videos.constants';

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

async function encode(path: string, args: string[]): Promise<Buffer> {
  await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...args, path]);
  return readFile(path);
}

/** MP4 H.264/AAC with 2 seconds, inside the TD-12 matrix. */
export function generateMp4Fixture(directory: string): Promise<Buffer> {
  return encode(join(directory, `${randomUUID()}.mp4`), [
    ...TEST_SOURCES,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
  ]);
}

/** MKV VP9/Opus, readable by FFmpeg but outside the TD-12 matrix. */
export function generateMkvFixture(directory: string): Promise<Buffer> {
  return encode(join(directory, `${randomUUID()}.mkv`), [
    ...TEST_SOURCES,
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
    '-c:a',
    'libopus',
  ]);
}

export async function createTestChannel(
  dataSource: DataSource,
): Promise<Channel> {
  const user = await dataSource.getRepository(User).save({
    email: `worker_${randomUUID()}@example.com`,
    password: 'hashed',
  });
  return dataSource.getRepository(Channel).save({
    name: 'Worker channel',
    nickname: `worker_${randomUUID().slice(0, 8)}`,
    user_id: user.id,
  });
}

export function insertTestVideo(
  dataSource: DataSource,
  channelId: string,
  overrides: Partial<Video> = {},
): Promise<Video> {
  return dataSource.getRepository(Video).save({
    channel_id: channelId,
    slug: generateVideoSlug(),
    status: VideoStatus.PROCESSING,
    original_filename: 'video.mp4',
    declared_size_bytes: 1024,
    size_bytes: 1024,
    part_size_bytes: VIDEO_PART_SIZE_BYTES,
    part_count: 1,
    ...overrides,
  });
}
