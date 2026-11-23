import { Module } from '@nestjs/common';
import { sqsClientProvider } from './queue.providers';
import { VideoProcessingQueueService } from './video-processing-queue.service';

@Module({
  providers: [sqsClientProvider, VideoProcessingQueueService],
  exports: [VideoProcessingQueueService],
})
export class QueueModule {}
