import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { DatabaseModule } from '../database/database.module';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import { FfmpegService } from './ffmpeg.service';
import { VideoCleanupService } from './video-cleanup.service';
import { VideoDlqConsumer } from './video-dlq.consumer';
import { VideoProcessingConsumer } from './video-processing.consumer';
import { VideoProcessorService } from './video-processor.service';
import { VideoReconcilerService } from './video-reconciler.service';

@Module({
  imports: [
    DatabaseModule,
    ScheduleModule.forRoot(),
    // Channel and User complete the relation graph that Video depends on.
    TypeOrmModule.forFeature([Video, Channel, User]),
    StorageModule,
    QueueModule,
  ],
  providers: [
    FfmpegService,
    VideoProcessorService,
    VideoProcessingConsumer,
    VideoReconcilerService,
    VideoDlqConsumer,
    VideoCleanupService,
  ],
})
export class VideoWorkerModule {}
