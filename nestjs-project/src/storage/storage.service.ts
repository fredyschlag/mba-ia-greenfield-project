import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import {
  LIST_PARTS_PAGE_SIZE,
  S3_INTERNAL_CLIENT,
  S3_MISSING_RESOURCE_ERRORS,
  S3_PRESIGN_CLIENT,
  UPLOAD_PART_URL_TTL_SECONDS,
} from './storage.constants';

export interface StoredPart {
  partNumber: number;
  sizeBytes: number;
  etag: string;
}

export interface CompletedPart {
  partNumber: number;
  etag: string;
}

export interface PublicGetObjectOptions {
  expiresInSeconds: number;
  responseContentType?: string;
  responseContentDisposition?: string;
}

function isMissingResource(error: unknown): boolean {
  return (
    error instanceof S3ServiceException &&
    (S3_MISSING_RESOURCE_ERRORS as readonly string[]).includes(error.name)
  );
}

@Injectable()
export class StorageService implements OnApplicationShutdown {
  private readonly bucket: string;

  constructor(
    @Inject(S3_INTERNAL_CLIENT) private readonly internalClient: S3Client,
    @Inject(S3_PRESIGN_CLIENT) private readonly presignClient: S3Client,
    @Inject(storageConfig.KEY) config: ConfigType<typeof storageConfig>,
  ) {
    this.bucket = config.bucket;
  }

  // Runs after beforeApplicationShutdown, when the consumers have stopped.
  onApplicationShutdown(): void {
    this.internalClient.destroy();
    this.presignClient.destroy();
  }

  async createMultipartUpload(key: string): Promise<string> {
    const { UploadId } = await this.internalClient.send(
      new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!UploadId) {
      throw new Error(`Storage returned no UploadId for ${key}`);
    }
    return UploadId;
  }

  /** Returns null when the multipart upload no longer exists. */
  async listAllParts(
    key: string,
    uploadId: string,
    pageSize: number = LIST_PARTS_PAGE_SIZE,
  ): Promise<StoredPart[] | null> {
    const parts: StoredPart[] = [];
    let marker: string | undefined;

    try {
      do {
        const page = await this.internalClient.send(
          new ListPartsCommand({
            Bucket: this.bucket,
            Key: key,
            UploadId: uploadId,
            MaxParts: pageSize,
            PartNumberMarker: marker,
          }),
        );
        for (const part of page.Parts ?? []) {
          parts.push({
            partNumber: part.PartNumber!,
            sizeBytes: part.Size!,
            etag: part.ETag!,
          });
        }
        marker = page.IsTruncated ? page.NextPartNumberMarker : undefined;
      } while (marker);
    } catch (error) {
      if (isMissingResource(error)) return null;
      throw error;
    }

    return parts;
  }

  /** Returns false when the multipart upload no longer exists. */
  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<boolean> {
    try {
      await this.internalClient.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: [...parts]
              .sort((a, b) => a.partNumber - b.partNumber)
              .map((part) => ({
                PartNumber: part.partNumber,
                ETag: part.etag,
              })),
          },
        }),
      );
      return true;
    } catch (error) {
      if (isMissingResource(error)) return false;
      throw error;
    }
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    try {
      await this.internalClient.send(
        new AbortMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
        }),
      );
    } catch (error) {
      if (!isMissingResource(error)) throw error;
    }
  }

  /** Returns null when the object does not exist. */
  async headObject(key: string): Promise<{ contentLength: number } | null> {
    try {
      const { ContentLength } = await this.internalClient.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return { contentLength: ContentLength ?? 0 };
    } catch (error) {
      if (isMissingResource(error)) return null;
      throw error;
    }
  }

  async putObject(
    key: string,
    body: Buffer,
    contentType?: string,
  ): Promise<void> {
    await this.internalClient.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async deleteObject(key: string): Promise<void> {
    try {
      await this.internalClient.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
      );
    } catch (error) {
      if (!isMissingResource(error)) throw error;
    }
  }

  async signUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    contentLength: number,
  ): Promise<string> {
    return getSignedUrl(
      this.presignClient,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
        ContentLength: contentLength,
      }),
      {
        expiresIn: UPLOAD_PART_URL_TTL_SECONDS,
        signableHeaders: new Set(['content-length']),
      },
    );
  }

  async signPublicGetObject(
    key: string,
    options: PublicGetObjectOptions,
  ): Promise<string> {
    return getSignedUrl(
      this.presignClient,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentType: options.responseContentType,
        ResponseContentDisposition: options.responseContentDisposition,
      }),
      { expiresIn: options.expiresInSeconds },
    );
  }

  async signInternalGetObject(
    key: string,
    expiresInSeconds: number,
  ): Promise<string> {
    return getSignedUrl(
      this.internalClient,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: expiresInSeconds },
    );
  }
}
