import { Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { DataSource, Repository } from 'typeorm';
import type { ChannelsService } from '../channels/channels.service';
import type videoConfig from '../config/video.config';
import type { VideoProcessingQueueService } from '../queue/video-processing-queue.service';
import type { StorageService } from '../storage/storage.service';
import { VideoStatus } from './entities/video-status.enum';
import { Video } from './entities/video.entity';
import { VideoUploadsService } from './video-uploads.service';
import {
  ActiveUploadLimitReachedException,
  ChannelNotFoundException,
  InvalidPartNumberException,
  UploadExpiredException,
  UploadIncompleteException,
  UploadNotActiveException,
  VideoNotFoundException,
  VideoSizeMismatchException,
  VideoTooLargeException,
} from './video.exceptions';

const USER_ID = 'user-id';
const UPLOAD_ID = 'upload-id';
const channel = { id: 'channel-id' };

describe('VideoUploadsService', () => {
  let manager: { count: jest.Mock; insert: jest.Mock; query: jest.Mock };
  let repositoryManager: { count: jest.Mock };
  let channels: { findByUserId: jest.Mock; lockByUserId: jest.Mock };
  let storage: {
    createMultipartUpload: jest.Mock;
    abortMultipartUpload: jest.Mock;
    signUploadPart: jest.Mock;
    listAllParts: jest.Mock;
    completeMultipartUpload: jest.Mock;
    headObject: jest.Mock;
    deleteObject: jest.Mock;
  };
  let queue: { enqueue: jest.Mock };
  let repository: { update: jest.Mock; findOneBy: jest.Mock };
  let queryBuilder: {
    addSelect: jest.Mock;
    innerJoin: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    getOne: jest.Mock;
  };
  let service: VideoUploadsService;

  function draftVideo(overrides: Partial<Video> = {}): Video {
    return Object.assign(new Video(), {
      id: 'video-id',
      status: VideoStatus.DRAFT,
      upload_id: UPLOAD_ID,
      upload_expires_at: new Date(Date.now() + 60_000),
      declared_size_bytes: 40_000_000,
      part_size_bytes: 16_777_216,
      part_count: 3,
      ...overrides,
    });
  }

  beforeEach(() => {
    manager = {
      count: jest.fn().mockResolvedValue(0),
      insert: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue(undefined),
    };
    repositoryManager = { count: jest.fn().mockResolvedValue(0) };
    channels = {
      findByUserId: jest.fn().mockResolvedValue(channel),
      lockByUserId: jest.fn().mockResolvedValue(channel),
    };
    storage = {
      createMultipartUpload: jest.fn().mockResolvedValue(UPLOAD_ID),
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
      signUploadPart: jest.fn(
        (_key: string, _uploadId: string, partNumber: number) =>
          Promise.resolve(`https://storage/part-${partNumber}`),
      ),
      listAllParts: jest.fn().mockResolvedValue([]),
      completeMultipartUpload: jest.fn().mockResolvedValue(true),
      headObject: jest.fn().mockResolvedValue({ contentLength: 40_000_000 }),
      deleteObject: jest.fn().mockResolvedValue(undefined),
    };
    queue = { enqueue: jest.fn().mockResolvedValue(undefined) };
    repository = {
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      findOneBy: jest.fn(),
    };
    queryBuilder = {
      addSelect: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(draftVideo()),
    };
    const dataSource = {
      transaction: jest.fn((callback: (m: typeof manager) => unknown) =>
        callback(manager),
      ),
    } as unknown as DataSource;

    service = new VideoUploadsService(
      dataSource,
      {
        manager: repositoryManager,
        createQueryBuilder: jest.fn(() => queryBuilder),
        ...repository,
      } as unknown as Repository<Video>,
      channels as unknown as ChannelsService,
      storage as unknown as StorageService,
      queue as unknown as VideoProcessingQueueService,
      { maxUploadBytes: 10_737_418_240 } as ConfigType<typeof videoConfig>,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('startUpload', () => {
    it('should create the draft with the computed part count', async () => {
      const result = await service.startUpload(USER_ID, {
        filename: 'video.mp4',
        sizeBytes: 40_000_000,
      });

      expect(result).toMatchObject({
        status: VideoStatus.DRAFT,
        partSizeBytes: 16_777_216,
        partCount: 3,
      });
      expect(manager.insert).toHaveBeenCalledWith(
        Video,
        expect.objectContaining({
          id: result.id,
          channel_id: channel.id,
          upload_id: UPLOAD_ID,
          original_filename: 'video.mp4',
        }),
      );
      expect(storage.createMultipartUpload).toHaveBeenCalledWith(
        `videos/${result.id}/source`,
      );
      expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
    });

    it('should reject a file above the limit before touching storage', async () => {
      await expect(
        service.startUpload(USER_ID, {
          filename: 'video.mp4',
          sizeBytes: 10_737_418_241,
        }),
      ).rejects.toBeInstanceOf(VideoTooLargeException);

      expect(channels.findByUserId).not.toHaveBeenCalled();
      expect(storage.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('should reject a user without channel before touching storage', async () => {
      channels.findByUserId.mockResolvedValue(null);

      await expect(
        service.startUpload(USER_ID, { filename: 'a.mp4', sizeBytes: 1 }),
      ).rejects.toBeInstanceOf(ChannelNotFoundException);

      expect(storage.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('should reject at the pre-check without creating a multipart', async () => {
      repositoryManager.count.mockResolvedValue(3);

      await expect(
        service.startUpload(USER_ID, { filename: 'a.mp4', sizeBytes: 1 }),
      ).rejects.toBeInstanceOf(ActiveUploadLimitReachedException);

      expect(storage.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('should abort the multipart when the locked recount hits the limit', async () => {
      manager.count.mockResolvedValue(3);

      await expect(
        service.startUpload(USER_ID, { filename: 'a.mp4', sizeBytes: 1 }),
      ).rejects.toBeInstanceOf(ActiveUploadLimitReachedException);

      expect(manager.insert).not.toHaveBeenCalled();
      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        expect.stringMatching(/^videos\/.+\/source$/),
        UPLOAD_ID,
      );
    });

    it('should abort the multipart and rethrow a persistence failure', async () => {
      const failure = new Error('insert failed');
      manager.insert.mockRejectedValue(failure);

      await expect(
        service.startUpload(USER_ID, { filename: 'a.mp4', sizeBytes: 1 }),
      ).rejects.toBe(failure);

      expect(storage.abortMultipartUpload).toHaveBeenCalledTimes(1);
    });

    it('should keep the original error when the abort also fails', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation();
      const failure = new Error('insert failed');
      manager.insert.mockRejectedValue(failure);
      storage.abortMultipartUpload.mockRejectedValue(new Error('abort failed'));

      await expect(
        service.startUpload(USER_ID, { filename: 'a.mp4', sizeBytes: 1 }),
      ).rejects.toBe(failure);
    });
  });

  describe('signParts', () => {
    it('should sign each part with its real content length', async () => {
      const result = await service.signParts(USER_ID, 'video-id', {
        partNumbers: [2, 3],
      });

      expect(result.parts).toEqual([
        {
          partNumber: 2,
          url: 'https://storage/part-2',
          contentLength: 16_777_216,
        },
        {
          partNumber: 3,
          url: 'https://storage/part-3',
          contentLength: 6_445_568,
        },
      ]);
      expect(storage.signUploadPart).toHaveBeenCalledWith(
        'videos/video-id/source',
        UPLOAD_ID,
        3,
        6_445_568,
      );
    });

    it('should use the full part size when the file is an exact multiple', async () => {
      queryBuilder.getOne.mockResolvedValue(
        draftVideo({ declared_size_bytes: 33_554_432, part_count: 2 }),
      );

      const result = await service.signParts(USER_ID, 'video-id', {
        partNumbers: [2],
      });

      expect(result.parts[0].contentLength).toBe(16_777_216);
    });

    it('should reject a part number above the part count', async () => {
      await expect(
        service.signParts(USER_ID, 'video-id', { partNumbers: [1, 4] }),
      ).rejects.toBeInstanceOf(InvalidPartNumberException);

      expect(storage.signUploadPart).not.toHaveBeenCalled();
    });

    it('should hide a video that is missing or from another channel', async () => {
      queryBuilder.getOne.mockResolvedValue(null);

      await expect(
        service.signParts(USER_ID, 'video-id', { partNumbers: [1] }),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it.each([VideoStatus.PROCESSING, VideoStatus.READY, VideoStatus.FAILED])(
      'should reject a video in %s',
      async (status) => {
        queryBuilder.getOne.mockResolvedValue(draftVideo({ status }));

        await expect(
          service.signParts(USER_ID, 'video-id', { partNumbers: [1] }),
        ).rejects.toBeInstanceOf(UploadNotActiveException);
      },
    );

    it('should reject an expired session', async () => {
      queryBuilder.getOne.mockResolvedValue(
        draftVideo({ upload_expires_at: new Date(Date.now() - 1) }),
      );

      await expect(
        service.signParts(USER_ID, 'video-id', { partNumbers: [1] }),
      ).rejects.toBeInstanceOf(UploadExpiredException);
    });
  });

  describe('listUploadedParts', () => {
    it('should return the upload layout and stored parts', async () => {
      const stored = [{ partNumber: 1, sizeBytes: 16_777_216, etag: '"a"' }];
      storage.listAllParts.mockResolvedValue(stored);

      await expect(
        service.listUploadedParts(USER_ID, 'video-id'),
      ).resolves.toMatchObject({
        partSizeBytes: 16_777_216,
        partCount: 3,
        parts: stored,
      });
    });

    it('should report an upload that no longer exists as not active', async () => {
      storage.listAllParts.mockResolvedValue(null);

      await expect(
        service.listUploadedParts(USER_ID, 'video-id'),
      ).rejects.toBeInstanceOf(UploadNotActiveException);
    });
  });

  describe('completeUpload', () => {
    const storedParts = [
      { partNumber: 1, sizeBytes: 16_777_216, etag: '"etag-1"' },
      { partNumber: 2, sizeBytes: 16_777_216, etag: '"etag-2"' },
      { partNumber: 3, sizeBytes: 6_445_568, etag: '"etag-3"' },
    ];
    const requestedParts = {
      parts: [
        { partNumber: 3, etag: 'etag-3' },
        { partNumber: 1, etag: '"etag-1"' },
        { partNumber: 2, etag: 'etag-2' },
      ],
    };

    beforeEach(() => {
      storage.listAllParts.mockResolvedValue(storedParts);
    });

    it('should complete, start processing and publish the message', async () => {
      await expect(
        service.completeUpload(USER_ID, 'video-id', requestedParts),
      ).resolves.toMatchObject({
        id: 'video-id',
        status: VideoStatus.PROCESSING,
      });

      expect(storage.completeMultipartUpload).toHaveBeenCalledWith(
        'videos/video-id/source',
        UPLOAD_ID,
        storedParts,
      );
      expect(repository.update).toHaveBeenNthCalledWith(
        1,
        { id: 'video-id', status: VideoStatus.DRAFT },
        {
          status: VideoStatus.PROCESSING,
          size_bytes: 40_000_000,
          upload_id: null,
          job_enqueued_at: null,
        },
      );
      expect(queue.enqueue).toHaveBeenCalledWith('video-id');
      expect(repository.update).toHaveBeenNthCalledWith(
        2,
        { id: 'video-id', status: VideoStatus.PROCESSING },
        { job_enqueued_at: expect.any(Date) as Date },
      );
    });

    it('should accept a retry after the multipart was already completed', async () => {
      storage.listAllParts.mockResolvedValue(null);

      await expect(
        service.completeUpload(USER_ID, 'video-id', requestedParts),
      ).resolves.toMatchObject({ status: VideoStatus.PROCESSING });

      expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
      expect(queue.enqueue).toHaveBeenCalledTimes(1);
    });

    it.each([VideoStatus.PROCESSING, VideoStatus.READY])(
      'should return accepted without a new message for a video in %s',
      async (status) => {
        queryBuilder.getOne.mockResolvedValue(
          draftVideo({ status, upload_id: null }),
        );

        await expect(
          service.completeUpload(USER_ID, 'video-id', requestedParts),
        ).resolves.toMatchObject({ status });

        expect(storage.listAllParts).not.toHaveBeenCalled();
        expect(queue.enqueue).not.toHaveBeenCalled();
      },
    );

    it('should not publish when a concurrent attempt won the transition', async () => {
      repository.update.mockResolvedValueOnce({ affected: 0 });
      repository.findOneBy.mockResolvedValue(
        draftVideo({ status: VideoStatus.PROCESSING }),
      );

      await expect(
        service.completeUpload(USER_ID, 'video-id', requestedParts),
      ).resolves.toMatchObject({ status: VideoStatus.PROCESSING });

      expect(queue.enqueue).not.toHaveBeenCalled();
    });

    it('should reject a video in failed', async () => {
      queryBuilder.getOne.mockResolvedValue(
        draftVideo({ status: VideoStatus.FAILED, upload_id: null }),
      );

      await expect(
        service.completeUpload(USER_ID, 'video-id', requestedParts),
      ).rejects.toBeInstanceOf(UploadNotActiveException);
    });

    it('should reject an expired session', async () => {
      queryBuilder.getOne.mockResolvedValue(
        draftVideo({ upload_expires_at: new Date(Date.now() - 1) }),
      );

      await expect(
        service.completeUpload(USER_ID, 'video-id', requestedParts),
      ).rejects.toBeInstanceOf(UploadExpiredException);
      expect(storage.listAllParts).not.toHaveBeenCalled();
    });

    it.each([
      ['a missing stored part', storedParts.slice(0, 2), requestedParts.parts],
      [
        'a stored size that differs from the declared size',
        [storedParts[0], storedParts[1], { ...storedParts[2], sizeBytes: 1 }],
        requestedParts.parts,
      ],
      ['a missing requested part', storedParts, requestedParts.parts.slice(1)],
      [
        'a different ETag',
        storedParts,
        [{ partNumber: 1, etag: 'other' }, ...requestedParts.parts.slice(0, 2)],
      ],
    ])('should keep the draft on %s', async (_name, stored, parts) => {
      storage.listAllParts.mockResolvedValue(stored);

      await expect(
        service.completeUpload(USER_ID, 'video-id', { parts }),
      ).rejects.toBeInstanceOf(UploadIncompleteException);

      expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('should remove the object and fail on a final size mismatch', async () => {
      storage.headObject.mockResolvedValue({ contentLength: 512 });

      await expect(
        service.completeUpload(USER_ID, 'video-id', requestedParts),
      ).rejects.toBeInstanceOf(VideoSizeMismatchException);

      expect(storage.deleteObject).toHaveBeenCalledWith(
        'videos/video-id/source',
      );
      expect(repository.update).toHaveBeenCalledWith(
        { id: 'video-id', status: VideoStatus.DRAFT },
        expect.objectContaining({
          status: VideoStatus.FAILED,
          failure_code: 'SIZE_MISMATCH',
          storage_purged_at: expect.any(Date) as Date,
        }),
      );
      expect(queue.enqueue).not.toHaveBeenCalled();
    });

    it('should report a draft without multipart or object as not active', async () => {
      storage.listAllParts.mockResolvedValue(null);
      storage.headObject.mockResolvedValue(null);

      await expect(
        service.completeUpload(USER_ID, 'video-id', requestedParts),
      ).rejects.toBeInstanceOf(UploadNotActiveException);
    });

    it('should stay accepted when publishing fails after the commit', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation();
      queue.enqueue.mockRejectedValue(new Error('queue unavailable'));

      await expect(
        service.completeUpload(USER_ID, 'video-id', requestedParts),
      ).resolves.toMatchObject({ status: VideoStatus.PROCESSING });

      expect(repository.update).toHaveBeenCalledTimes(1);
    });
  });
});
