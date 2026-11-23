import {
  GetQueueAttributesCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import {
  TEST_VIDEO_PROCESSING_DLQ_URL,
  TEST_VIDEO_PROCESSING_QUEUE_URL,
} from './test-environment';

export interface QueueDepth {
  visible: number;
  inFlight: number;
}

export function createTestSqsClient(): SQSClient {
  return new SQSClient({
    region: process.env.SQS_REGION,
    endpoint: process.env.SQS_ENDPOINT,
  });
}

export async function purgeTestQueues(client: SQSClient): Promise<void> {
  for (const QueueUrl of [
    TEST_VIDEO_PROCESSING_QUEUE_URL,
    TEST_VIDEO_PROCESSING_DLQ_URL,
  ]) {
    await client.send(new PurgeQueueCommand({ QueueUrl }));
  }
}

export async function queueDepth(
  client: SQSClient,
  QueueUrl: string = TEST_VIDEO_PROCESSING_QUEUE_URL,
): Promise<QueueDepth> {
  const { Attributes } = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl,
      AttributeNames: [
        'ApproximateNumberOfMessages',
        'ApproximateNumberOfMessagesNotVisible',
      ],
    }),
  );
  return {
    visible: Number(Attributes?.ApproximateNumberOfMessages ?? 0),
    inFlight: Number(Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0),
  };
}

/** Reads without waiting and hides the messages only for a moment. */
export async function peekMessageBodies(
  client: SQSClient,
  QueueUrl: string = TEST_VIDEO_PROCESSING_QUEUE_URL,
): Promise<string[]> {
  const { Messages = [] } = await client.send(
    new ReceiveMessageCommand({
      QueueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 0,
      VisibilityTimeout: 1,
    }),
  );
  return Messages.map((message) => message.Body ?? '');
}

export async function sendRawTestMessage(
  client: SQSClient,
  MessageBody: string,
  QueueUrl: string = TEST_VIDEO_PROCESSING_QUEUE_URL,
): Promise<void> {
  await client.send(new SendMessageCommand({ QueueUrl, MessageBody }));
}
