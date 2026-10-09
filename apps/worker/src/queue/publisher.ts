import { Channel } from 'amqplib';
import {
  FORGEFLOW_RETRY_EXCHANGE,
  FORGEFLOW_RETRY_ROUTING_KEY,
  FORGEFLOW_DLX_EXCHANGE,
  FORGEFLOW_DLQ_ROUTING_KEY,
  FORGEFLOW_JOBS_QUEUE,
  JobQueueMessage,
  injectTraceContext,
} from '@forgeflow/shared';

export interface RetryPublishMetadata {
  retryCount: number;
  error: string;
  requestId?: string;
}

export interface DlqPublishMetadata {
  reason: string;
  error?: string;
  retryCount?: number;
  requestId?: string;
}

/**
 * Publishes a message to the Retry Exchange with a per-message TTL (expiration).
 * When the message expires in the delay queue, RabbitMQ dead-letters it back to 'forgeflow.jobs'.
 */
export async function publishToRetry(
  ch: Channel,
  message: JobQueueMessage,
  delayMs: number,
  metadata: RetryPublishMetadata
): Promise<boolean> {
  const boundedDelay = Math.max(100, Math.round(delayMs));
  const payloadBuffer = Buffer.from(JSON.stringify(message));
  const reqId = metadata.requestId || message.requestId;

  const headers: Record<string, any> = {
    'x-retry-count': metadata.retryCount,
    'x-last-error': metadata.error,
    'x-original-queue': FORGEFLOW_JOBS_QUEUE,
    'x-delay-ms': boundedDelay,
    'x-retried-at': new Date().toISOString(),
    ...(reqId ? { 'x-request-id': reqId } : {}),
  };
  injectTraceContext(headers);

  return ch.publish(
    FORGEFLOW_RETRY_EXCHANGE,
    FORGEFLOW_RETRY_ROUTING_KEY,
    payloadBuffer,
    {
      persistent: true,
      expiration: String(boundedDelay),
      contentType: 'application/json',
      headers,
    }
  );
}

/**
 * Publishes a poisoned, non-retryable, or exhausted message to the Dead Letter Queue (DLQ).
 */
export async function publishToDLQ(
  ch: Channel,
  message: JobQueueMessage | Buffer,
  metadata: DlqPublishMetadata
): Promise<boolean> {
  const payloadBuffer = Buffer.isBuffer(message)
    ? message
    : Buffer.from(JSON.stringify(message));

  const reqId =
    metadata.requestId ||
    (!Buffer.isBuffer(message) ? message.requestId : undefined);

  const headers: Record<string, any> = {
    'x-rejection-reason': metadata.reason,
    'x-error-message': metadata.error || '',
    'x-retry-count': metadata.retryCount ?? 0,
    'x-original-queue': FORGEFLOW_JOBS_QUEUE,
    'x-failed-at': new Date().toISOString(),
    ...(reqId ? { 'x-request-id': reqId } : {}),
  };
  injectTraceContext(headers);

  return ch.publish(
    FORGEFLOW_DLX_EXCHANGE,
    FORGEFLOW_DLQ_ROUTING_KEY,
    payloadBuffer,
    {
      persistent: true,
      contentType: 'application/json',
      headers,
    }
  );
}

