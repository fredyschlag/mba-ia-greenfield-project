import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { isUUID } from 'class-validator';
import queueConfig from '../config/queue.config';
import {
  QUEUE_LONG_POLL_SECONDS,
  RECEIVE_COUNT_ATTRIBUTE,
  SQS_CLIENT,
} from './queue.constants';

export interface VideoProcessingMessage {
  /** Null when the payload is not a valid `{ videoId }` message. */
  videoId: string | null;
  receiptHandle: string;
  receiveCount: number;
}

function parseVideoId(body: string | undefined): string | null {
  try {
    const payload = JSON.parse(body ?? '') as { videoId?: unknown };
    return typeof payload.videoId === 'string' && isUUID(payload.videoId)
      ? payload.videoId
      : null;
  } catch {
    return null;
  }
}

function toVideoProcessingMessage(message: Message): VideoProcessingMessage {
  return {
    videoId: parseVideoId(message.Body),
    receiptHandle: message.ReceiptHandle!,
    receiveCount: Number(message.Attributes?.[RECEIVE_COUNT_ATTRIBUTE] ?? 1),
  };
}

@Injectable()
export class VideoProcessingQueueService implements OnApplicationShutdown {
  private readonly queueUrl: string;
  private readonly deadLetterQueueUrl: string;

  constructor(
    @Inject(SQS_CLIENT) private readonly client: SQSClient,
    @Inject(queueConfig.KEY) config: ConfigType<typeof queueConfig>,
  ) {
    this.queueUrl = config.videoProcessingQueueUrl;
    this.deadLetterQueueUrl = config.videoProcessingDlqUrl;
  }

  // Runs after beforeApplicationShutdown, when the consumers have stopped.
  onApplicationShutdown(): void {
    this.client.destroy();
  }

  async enqueue(videoId: string): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify({ videoId }),
      }),
    );
  }

  async receive(
    waitTimeSeconds: number = QUEUE_LONG_POLL_SECONDS,
    abortSignal?: AbortSignal,
  ): Promise<VideoProcessingMessage | null> {
    return this.receiveFrom(this.queueUrl, waitTimeSeconds, abortSignal);
  }

  async changeVisibility(
    receiptHandle: string,
    visibilityTimeoutSeconds: number,
  ): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: visibilityTimeoutSeconds,
      }),
    );
  }

  async delete(receiptHandle: string): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: receiptHandle,
      }),
    );
  }

  async receiveDeadLetter(
    waitTimeSeconds: number = QUEUE_LONG_POLL_SECONDS,
    abortSignal?: AbortSignal,
  ): Promise<VideoProcessingMessage | null> {
    return this.receiveFrom(
      this.deadLetterQueueUrl,
      waitTimeSeconds,
      abortSignal,
    );
  }

  async deleteDeadLetter(receiptHandle: string): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: this.deadLetterQueueUrl,
        ReceiptHandle: receiptHandle,
      }),
    );
  }

  private async receiveFrom(
    queueUrl: string,
    waitTimeSeconds: number,
    abortSignal?: AbortSignal,
  ): Promise<VideoProcessingMessage | null> {
    const { Messages } = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: waitTimeSeconds,
        MessageSystemAttributeNames: [RECEIVE_COUNT_ATTRIBUTE],
      }),
      { abortSignal },
    );
    const message = Messages?.[0];
    return message ? toVideoProcessingMessage(message) : null;
  }
}
