import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource, type Repository } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { AuthService } from '../../src/auth/auth.service';
import { Channel } from '../../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../../src/common/filters/domain-exception.filter';
import { ThrottlerExceptionFilter } from '../../src/common/filters/throttler-exception.filter';
import { ValidationExceptionFilter } from '../../src/common/filters/validation-exception.filter';
import type { MailService } from '../../src/mail/mail.service';
import {
  videoSourceKey,
  videoThumbnailKey,
} from '../../src/storage/storage-keys';
import { StorageService } from '../../src/storage/storage.service';
import { signedRequest } from '../../src/test/signed-request';
import { Video } from '../../src/videos/entities/video.entity';

export const E2E_TIMEOUT_MS = 60_000;

export interface VideoE2eContext {
  app: INestApplication<App>;
  dataSource: DataSource;
  throttlerStorage: ThrottlerStorageService;
  storage: StorageService;
  videos: Repository<Video>;
  channels: Repository<Channel>;
}

export interface TestUser {
  id: string;
  email: string;
  token: string;
}

export async function createVideoE2eContext(): Promise<VideoE2eContext> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication<INestApplication<App>>();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(
    new DomainExceptionFilter(),
    new ValidationExceptionFilter(),
    new ThrottlerExceptionFilter(),
  );
  // Concurrent supertest calls need a server that is already listening.
  await app.listen(0);

  const dataSource = moduleRef.get(DataSource);
  return {
    app,
    dataSource,
    throttlerStorage: moduleRef.get<ThrottlerStorageService>(ThrottlerStorage),
    storage: moduleRef.get(StorageService),
    videos: dataSource.getRepository(Video),
    channels: dataSource.getRepository(Channel),
  };
}

export async function registerConfirmAndLogin(
  context: VideoE2eContext,
  email: string,
  password = 'password123',
): Promise<TestUser> {
  const { app } = context;
  const authService = app.get(AuthService);
  const mailService = (authService as unknown as { mailService: MailService })
    .mailService;
  let confirmationToken = '';
  const mailSpy = jest
    .spyOn(mailService, 'sendConfirmationEmail')
    .mockImplementationOnce((_email: string, _name: string, token: string) => {
      confirmationToken = token;
      return Promise.resolve();
    });

  const registered = await request(app.getHttpServer())
    .post('/auth/register')
    .send({ email, password })
    .expect(201);
  mailSpy.mockRestore();

  await request(app.getHttpServer())
    .get('/auth/confirm-email')
    .query({ token: confirmationToken })
    .expect(204);
  const login = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password })
    .expect(200);

  // Registering users must not consume the rate limit of the scenario.
  context.throttlerStorage.storage.clear();

  return {
    id: (registered.body as { id: string }).id,
    email,
    token: (login.body as { access_token: string }).access_token,
  };
}

export async function cleanVideoStorage(
  context: VideoE2eContext,
): Promise<void> {
  const videos = await context.videos
    .createQueryBuilder('video')
    .addSelect('video.upload_id')
    .getMany();

  for (const video of videos) {
    const key = videoSourceKey(video.id);
    if (video.upload_id) {
      await context.storage.abortMultipartUpload(key, video.upload_id);
    }
    await context.storage.deleteObject(key);
    await context.storage.deleteObject(videoThumbnailKey(video.id));
  }
}

export async function readUploadId(
  context: VideoE2eContext,
  videoId: string,
): Promise<string | null> {
  const video = await context.videos
    .createQueryBuilder('video')
    .addSelect('video.upload_id')
    .where('video.id = :videoId', { videoId })
    .getOneOrFail();
  return video.upload_id;
}

export interface CreatedVideo {
  id: string;
  slug: string;
  status: string;
  partSizeBytes: number;
  partCount: number;
  uploadExpiresAt: string;
}

export async function createDraft(
  context: VideoE2eContext,
  token: string,
  sizeBytes: number,
  filename = 'video.mp4',
): Promise<CreatedVideo> {
  const response = await request(context.app.getHttpServer())
    .post('/videos')
    .set('Authorization', `Bearer ${token}`)
    .send({ filename, sizeBytes })
    .expect(201);
  return response.body as CreatedVideo;
}

export interface SignedPart {
  partNumber: number;
  url: string;
  contentLength: number;
}

export async function signParts(
  context: VideoE2eContext,
  token: string,
  videoId: string,
  partNumbers: number[],
): Promise<SignedPart[]> {
  const response = await request(context.app.getHttpServer())
    .post(`/videos/${videoId}/upload/part-urls`)
    .set('Authorization', `Bearer ${token}`)
    .send({ partNumbers })
    .expect(201);
  return (response.body as { parts: SignedPart[] }).parts;
}

export async function uploadPart(
  context: VideoE2eContext,
  token: string,
  videoId: string,
  partNumber: number,
  content: Buffer,
): Promise<string> {
  const [part] = await signParts(context, token, videoId, [partNumber]);
  const response = await signedRequest(part.url, {
    method: 'PUT',
    body: content,
  });
  if (response.status !== 200) {
    throw new Error(`Part upload failed with status ${response.status}`);
  }
  return response.headers.etag as string;
}
