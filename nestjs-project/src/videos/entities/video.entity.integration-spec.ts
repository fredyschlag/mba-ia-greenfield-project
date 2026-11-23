import { randomUUID } from 'node:crypto';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { ALL_ENTITIES } from '../../test/migration-list';
import { User } from '../../users/entities/user.entity';
import { VideoStatus } from './video-status.enum';
import { Video } from './video.entity';

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let channel: Channel;
  let counter = 0;

  function buildVideo(overrides: Partial<Video> = {}): Video {
    counter += 1;
    return videoRepository.create({
      channel_id: channel.id,
      slug: `slug${String(counter).padStart(7, '0')}`,
      original_filename: 'video.mp4',
      declared_size_bytes: 1024,
      part_size_bytes: 16_777_216,
      part_count: 1,
      ...overrides,
    });
  }

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES, { synchronize: false });
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await userRepository.save(
      userRepository.create({
        email: `video_user_${randomUUID()}@example.com`,
        password: 'hashed',
      }),
    );
    channel = await channelRepository.save(
      channelRepository.create({
        name: 'Video channel',
        nickname: `video_${randomUUID().slice(0, 8)}`,
        user_id: user.id,
      }),
    );
  });

  it('should persist draft as the default status', async () => {
    const saved = await videoRepository.save(buildVideo());

    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.status).toBe(VideoStatus.DRAFT);
  });

  it('should reject a status outside the enum', async () => {
    await expect(
      videoRepository.save(
        buildVideo({ status: 'published' as unknown as VideoStatus }),
      ),
    ).rejects.toThrow(QueryFailedError);
  });

  it('should enforce a unique slug', async () => {
    await videoRepository.save(buildVideo({ slug: 'duplicate01' }));

    await expect(
      videoRepository.save(buildVideo({ slug: 'duplicate01' })),
    ).rejects.toThrow(QueryFailedError);
  });

  it('should reject a video with a nonexistent channel', async () => {
    await expect(
      videoRepository.save(buildVideo({ channel_id: randomUUID() })),
    ).rejects.toThrow(QueryFailedError);
  });

  it('should reject removing a channel that has videos', async () => {
    await videoRepository.save(buildVideo());

    await expect(channelRepository.delete(channel.id)).rejects.toThrow(
      QueryFailedError,
    );
    expect(await channelRepository.countBy({ id: channel.id })).toBe(1);
  });

  it('should exclude upload_id from default queries', async () => {
    const saved = await videoRepository.save(
      buildVideo({ upload_id: 'multipart-upload-id' }),
    );

    const byDefault = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(byDefault.upload_id).toBeUndefined();

    const explicit = await videoRepository
      .createQueryBuilder('video')
      .addSelect('video.upload_id')
      .where('video.id = :id', { id: saved.id })
      .getOneOrFail();
    expect(explicit.upload_id).toBe('multipart-upload-id');
  });

  it('should read bigint and numeric columns as exact numbers', async () => {
    const saved = await videoRepository.save(
      buildVideo({
        declared_size_bytes: 10_737_418_240,
        size_bytes: 10_737_418_240,
        duration_seconds: 302_401.125,
      }),
    );

    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.declared_size_bytes).toBe(10_737_418_240);
    expect(found.size_bytes).toBe(10_737_418_240);
    expect(found.duration_seconds).toBe(302_401.125);
  });

  it('should keep optional columns null until they are filled', async () => {
    const saved = await videoRepository.save(buildVideo());

    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.size_bytes).toBeNull();
    expect(found.duration_seconds).toBeNull();
    expect(found.job_enqueued_at).toBeNull();
    expect(found.failure_code).toBeNull();
    expect(found.storage_purge_after).toBeNull();
    expect(found.storage_purged_at).toBeNull();
  });
});
