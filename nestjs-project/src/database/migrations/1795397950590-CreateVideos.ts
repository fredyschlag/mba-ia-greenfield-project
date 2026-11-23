import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateVideos1795397950590 implements MigrationInterface {
  name = 'CreateVideos1795397950590';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."videos_status_enum" AS ENUM('draft', 'processing', 'ready', 'failed')`,
    );
    await queryRunner.query(
      `CREATE TABLE "videos" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "channel_id" uuid NOT NULL, "slug" character varying(11) NOT NULL, "status" "public"."videos_status_enum" NOT NULL DEFAULT 'draft', "original_filename" character varying(255) NOT NULL, "declared_size_bytes" bigint NOT NULL, "size_bytes" bigint, "part_size_bytes" integer NOT NULL, "part_count" integer NOT NULL, "upload_id" text, "upload_expires_at" TIMESTAMP WITH TIME ZONE, "job_enqueued_at" TIMESTAMP WITH TIME ZONE, "content_type" character varying(100), "duration_seconds" numeric(12,3), "width" integer, "height" integer, "container" character varying(100), "video_codec" character varying(50), "audio_codec" character varying(50), "thumbnail_key" character varying(255), "failure_code" character varying(50), "storage_purge_after" TIMESTAMP WITH TIME ZONE, "storage_purged_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_5dbcc1ee100f853490582eccc71" UNIQUE ("slug"), CONSTRAINT "PK_e4c86c0cf95aff16e9fb8220f6b" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_videos_failed_storage_purge_after" ON "videos" ("storage_purge_after") WHERE "status" = 'failed' AND "storage_purged_at" IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_videos_processing_job_enqueued_at" ON "videos" ("job_enqueued_at") WHERE "status" = 'processing'`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_videos_draft_upload_expires_at" ON "videos" ("upload_expires_at") WHERE "status" = 'draft'`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_videos_draft_channel_id" ON "videos" ("channel_id") WHERE "status" = 'draft'`,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" ADD CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "videos" DROP CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_videos_draft_channel_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_videos_draft_upload_expires_at"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_videos_processing_job_enqueued_at"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_videos_failed_storage_purge_after"`,
    );
    await queryRunner.query(`DROP TABLE "videos"`);
    await queryRunner.query(`DROP TYPE "public"."videos_status_enum"`);
  }
}
