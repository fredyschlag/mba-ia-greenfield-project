import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { VideoProcessingQueueService } from '../queue/video-processing-queue.service';
import { StorageService } from '../storage/storage.service';
import { Video } from '../videos/entities/video.entity';
import { VideoWorkerModule } from './video-worker.module';

describe('VideoWorkerModule', () => {
  it('should compile with storage, queue and the video repository', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [VideoWorkerModule],
    }).compile();

    expect(moduleRef.get(StorageService, { strict: false })).toBeInstanceOf(
      StorageService,
    );
    expect(
      moduleRef.get(VideoProcessingQueueService, { strict: false }),
    ).toBeInstanceOf(VideoProcessingQueueService);
    expect(
      moduleRef.get(getRepositoryToken(Video), { strict: false }),
    ).toBeDefined();
    await moduleRef.close();
  });
});
