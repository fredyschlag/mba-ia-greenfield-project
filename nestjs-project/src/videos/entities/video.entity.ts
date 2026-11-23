import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  type ValueTransformer,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { VideoStatus } from './video-status.enum';

// PostgreSQL returns bigint and numeric as strings. Every value stored here
// stays within Number.MAX_SAFE_INTEGER (uploads are limited to 10 GiB).
const numericTransformer: ValueTransformer = {
  to: (value: number | null | undefined) => value,
  from: (value: string | null) => (value === null ? null : Number(value)),
};

@Entity('videos')
@Index('IDX_videos_draft_channel_id', ['channel_id'], {
  where: `"status" = 'draft'`,
})
@Index('IDX_videos_draft_upload_expires_at', ['upload_expires_at'], {
  where: `"status" = 'draft'`,
})
@Index('IDX_videos_processing_job_enqueued_at', ['job_enqueued_at'], {
  where: `"status" = 'processing'`,
})
@Index('IDX_videos_failed_storage_purge_after', ['storage_purge_after'], {
  where: `"status" = 'failed' AND "storage_purged_at" IS NULL`,
})
export class Video {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  channel_id: string;

  @Column({ type: 'varchar', length: 11, unique: true })
  slug: string;

  @Column({
    type: 'enum',
    enum: VideoStatus,
    default: VideoStatus.DRAFT,
  })
  status: VideoStatus;

  @Column({ type: 'varchar', length: 255 })
  original_filename: string;

  @Column({ type: 'bigint', transformer: numericTransformer })
  declared_size_bytes: number;

  @Column({ type: 'bigint', nullable: true, transformer: numericTransformer })
  size_bytes: number | null;

  @Column({ type: 'integer' })
  part_size_bytes: number;

  @Column({ type: 'integer' })
  part_count: number;

  @Column({ type: 'text', nullable: true, select: false })
  upload_id: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  upload_expires_at: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  job_enqueued_at: Date | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  content_type: string | null;

  @Column({
    type: 'numeric',
    precision: 12,
    scale: 3,
    nullable: true,
    transformer: numericTransformer,
  })
  duration_seconds: number | null;

  @Column({ type: 'integer', nullable: true })
  width: number | null;

  @Column({ type: 'integer', nullable: true })
  height: number | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  container: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  video_codec: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  audio_codec: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  thumbnail_key: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  failure_code: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  storage_purge_after: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  storage_purged_at: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;

  @ManyToOne(() => Channel, (channel) => channel.videos, {
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;
}
