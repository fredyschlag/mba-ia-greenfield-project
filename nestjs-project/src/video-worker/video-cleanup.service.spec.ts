import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { Video } from '../videos/entities/video.entity';
import { VideoCleanupService } from './video-cleanup.service';

const FIRST_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_ID = '22222222-2222-4222-8222-222222222222';

describe('VideoCleanupService', () => {
  let service: VideoCleanupService;
  let logError: jest.SpyInstance;
  const queryBuilder = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    setLock: jest.fn().mockReturnThis(),
    setOnLocked: jest.fn().mockReturnThis(),
    getOne: jest.fn(),
  };
  const manager = {
    getRepository: jest.fn(() => ({
      createQueryBuilder: () => queryBuilder,
    })),
    delete: jest.fn(),
    update: jest.fn(),
  };
  const dataSource = {
    transaction: jest.fn((callback: (m: typeof manager) => Promise<unknown>) =>
      callback(manager),
    ),
  };
  const storage = {
    abortMultipartUpload: jest.fn(),
    deleteObject: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    queryBuilder.getOne.mockReset();
    storage.abortMultipartUpload.mockReset().mockResolvedValue(undefined);
    storage.deleteObject.mockReset().mockResolvedValue(undefined);
    logError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    const moduleRef = await Test.createTestingModule({
      providers: [
        VideoCleanupService,
        { provide: DataSource, useValue: dataSource },
        { provide: StorageService, useValue: storage },
      ],
    }).compile();
    service = moduleRef.get(VideoCleanupService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should continue the draft batch after one item fails', async () => {
    queryBuilder.getOne
      .mockResolvedValueOnce({ id: FIRST_ID, upload_id: 'first-upload' })
      .mockResolvedValueOnce({ id: SECOND_ID, upload_id: 'second-upload' })
      .mockResolvedValueOnce(null);
    storage.abortMultipartUpload.mockRejectedValueOnce(new Error('storage'));

    await expect(service.sweepExpiredDrafts()).resolves.toBe(1);

    expect(manager.delete).toHaveBeenCalledTimes(1);
    expect(manager.delete).toHaveBeenCalledWith(Video, { id: SECOND_ID });
    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      'video.id NOT IN (:...excludedIds)',
      { excludedIds: [FIRST_ID] },
    );
  });

  it('should not delete the row when removing the object fails', async () => {
    queryBuilder.getOne
      .mockResolvedValueOnce({ id: FIRST_ID, upload_id: null })
      .mockResolvedValueOnce(null);
    storage.deleteObject.mockRejectedValueOnce(new Error('storage'));

    await expect(service.sweepExpiredDrafts()).resolves.toBe(0);

    expect(manager.delete).not.toHaveBeenCalled();
  });

  it('should continue the purge batch after one item fails', async () => {
    queryBuilder.getOne
      .mockResolvedValueOnce({ id: FIRST_ID })
      .mockResolvedValueOnce({ id: SECOND_ID })
      .mockResolvedValueOnce(null);
    storage.deleteObject.mockRejectedValueOnce(new Error('storage'));

    await expect(service.purgeFailedVideos()).resolves.toBe(1);

    expect(manager.update).toHaveBeenCalledTimes(1);
    expect(manager.update).toHaveBeenCalledWith(
      Video,
      { id: SECOND_ID },
      { storage_purged_at: expect.any(Function) as unknown },
    );
  });

  it('should stop when every item of the batch keeps failing', async () => {
    let next = 0;
    queryBuilder.getOne.mockImplementation(() => {
      next += 1;
      return Promise.resolve({ id: `video-${next}`, upload_id: null });
    });
    storage.deleteObject.mockRejectedValue(new Error('storage'));

    await expect(service.sweepExpiredDrafts()).resolves.toBe(0);

    expect(queryBuilder.getOne).toHaveBeenCalledTimes(100);
  });

  it('should run the purge even when the draft sweep fails', async () => {
    queryBuilder.getOne
      .mockRejectedValueOnce(new Error('relation does not exist'))
      .mockResolvedValueOnce({ id: FIRST_ID })
      .mockResolvedValueOnce(null);

    await expect(service.handleSchedule()).resolves.toBeUndefined();

    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining('Expired draft sweep failed'),
    );
    expect(manager.update).toHaveBeenCalledTimes(1);
  });
});
