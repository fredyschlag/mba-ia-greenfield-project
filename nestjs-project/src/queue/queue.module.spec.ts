import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import queueConfig from '../config/queue.config';
import { QueueModule } from './queue.module';
import { VideoProcessingQueueService } from './video-processing-queue.service';

describe('QueueModule', () => {
  it('should compile and export VideoProcessingQueueService', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
    }).compile();

    expect(moduleRef.get(VideoProcessingQueueService)).toBeInstanceOf(
      VideoProcessingQueueService,
    );
    await moduleRef.close();
  });
});
