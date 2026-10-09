import amqp, { Channel, ChannelModel, ConsumeMessage } from 'amqplib';
import { env } from '../config/env';
import {
  FORGEFLOW_JOBS_QUEUE,
  FORGEFLOW_RETRY_EXCHANGE,
  FORGEFLOW_RETRY_QUEUE,
  FORGEFLOW_RETRY_ROUTING_KEY,
  FORGEFLOW_DLX_EXCHANGE,
  FORGEFLOW_DLQ_QUEUE,
  FORGEFLOW_DLQ_ROUTING_KEY,
  JobQueueMessage,
  workerDlqMessagesTotal,
  extractTraceContext,
  withSpan,
  SpanKind,
} from '@forgeflow/shared';
import { processJob } from '../processors/jobProcessor';
import { workerDb } from '../db';
import { invalidateJobCache } from '../cache/redis';
import { publishToRetry, publishToDLQ } from './publisher';
import { workerLogger, WORKER_ID } from '../config/logger';

let connection: ChannelModel | null = null;
let channel: Channel | null = null;

export async function startConsumer(): Promise<void> {
  workerLogger.info('worker_queue_connecting', { url: env.RABBITMQ_URL });

  try {
    const conn = await amqp.connect(env.RABBITMQ_URL);
    connection = conn;

    (conn as any).on('error', (err: any) => {
      workerLogger.error('worker_rabbitmq_connection_error', {}, err);
    });

    (conn as any).on('close', () => {
      workerLogger.warn('worker_rabbitmq_connection_closed', {}, 'Reconnecting in 5s...');
      setTimeout(() => startConsumer().catch(console.error), 5000);
    });

    const ch = await conn.createChannel();
    channel = ch;

    ch.on('error', (err: any) => {
      workerLogger.error('worker_rabbitmq_channel_error', {}, err);
    });

    ch.on('close', () => {
      workerLogger.warn('worker_rabbitmq_channel_closed');
    });

    // 1. Assert Dead Letter Exchange & DLQ Queue
    await ch.assertExchange(FORGEFLOW_DLX_EXCHANGE, 'direct', { durable: true });
    await ch.assertQueue(FORGEFLOW_DLQ_QUEUE, { durable: true });
    await ch.bindQueue(FORGEFLOW_DLQ_QUEUE, FORGEFLOW_DLX_EXCHANGE, FORGEFLOW_DLQ_ROUTING_KEY);

    // 2. Assert Retry Exchange & Delay Queue (dead-letters back to default exchange -> forgeflow.jobs on TTL expiry)
    await ch.assertExchange(FORGEFLOW_RETRY_EXCHANGE, 'direct', { durable: true });
    await ch.assertQueue(FORGEFLOW_RETRY_QUEUE, {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': '',
        'x-dead-letter-routing-key': FORGEFLOW_JOBS_QUEUE,
      },
    });
    await ch.bindQueue(FORGEFLOW_RETRY_QUEUE, FORGEFLOW_RETRY_EXCHANGE, FORGEFLOW_RETRY_ROUTING_KEY);

    // 3. Assert Main Jobs Queue
    await ch.assertQueue(FORGEFLOW_JOBS_QUEUE, {
      durable: true,
    });

    // Process one message at a time
    await ch.prefetch(1);

    workerLogger.info('worker_consumer_started', {
      queue: FORGEFLOW_JOBS_QUEUE,
      prefetch: 1,
      manualAck: true,
    });

    // Consume messages with manual acknowledgment (noAck: false)
    await ch.consume(
      FORGEFLOW_JOBS_QUEUE,
      async (msg: ConsumeMessage | null) => {
        if (!msg) return;

        let parsed: JobQueueMessage | null = null;

        try {
          const contentStr = msg.content.toString();
          parsed = JSON.parse(contentStr) as JobQueueMessage;

          // Extract incoming W3C trace context from RabbitMQ headers or message payload (Phase 9.4)
          const incomingHeaders = {
            ...(msg.properties.headers || {}),
            ...(parsed?.traceparent ? { traceparent: parsed.traceparent, tracestate: parsed.tracestate } : {}),
          };
          const parentContext = extractTraceContext(incomingHeaders);

          // Wrap complete job execution in an active OpenTelemetry CONSUMER span
          await withSpan(
            `job_process ${parsed?.type || 'UNKNOWN'}`,
            async (span) => {
              span.setAttributes({
                'messaging.system': 'rabbitmq',
                'messaging.destination.name': FORGEFLOW_JOBS_QUEUE,
                'job.id': parsed?.jobId,
                'job.type': parsed?.type,
                'worker.instance': WORKER_ID,
              });

              // Process the job
              const result = await processJob(parsed!);

              if (result.action === 'COMPLETED') {
                ch.ack(msg);
                workerLogger.debug('message_acked', { jobId: parsed!.jobId, requestId: parsed!.requestId, action: 'COMPLETED' });
              } else if (result.action === 'SKIP') {
                ch.ack(msg);
                workerLogger.debug('message_acked', { jobId: parsed!.jobId, requestId: parsed!.requestId, action: 'SKIP', reason: result.reason });
              } else if (result.action === 'RETRY') {
                // Publish to Retry Queue with per-message expiration TTL, then ACK original message
                await publishToRetry(ch, parsed!, result.delayMs, {
                  retryCount: result.retryCount,
                  error: result.error,
                  requestId: parsed!.requestId,
                });
                ch.ack(msg);
                workerLogger.debug('message_acked', { jobId: parsed!.jobId, requestId: parsed!.requestId, action: 'RETRY', delayMs: result.delayMs });
              } else if (result.action === 'DLQ') {
                // Publish to Dead Letter Queue (DLQ), then ACK original message
                await publishToDLQ(ch, parsed!, {
                  reason: result.reason,
                  error: result.error,
                  retryCount: result.retryCount,
                  requestId: parsed!.requestId,
                });
                ch.ack(msg);
                workerLogger.debug('message_acked', { jobId: parsed!.jobId, requestId: parsed!.requestId, action: 'DLQ', reason: result.reason });
              }
            },
            {
              kind: SpanKind.CONSUMER,
            },
            parentContext
          );
        } catch (err: any) {
          workerLogger.error('worker_poison_message_error', { jobId: parsed?.jobId, requestId: parsed?.requestId }, err);

          try {
            // Route unparseable / poison message to DLQ so queue doesn't block
            await publishToDLQ(ch, msg.content, {
              reason: 'POISON_UNPARSEABLE_MESSAGE',
              error: err.message,
              requestId: parsed?.requestId,
            });

            workerDlqMessagesTotal.inc({
              type: parsed?.type || 'UNKNOWN',
              reason: 'POISON_UNPARSEABLE_MESSAGE',
            });

            if (parsed?.jobId) {
              await workerDb.failJobAndExecution(parsed.jobId, err.message || 'Worker processing error');
              await invalidateJobCache(parsed.jobId);
            }
          } catch (dlqErr: any) {
            workerLogger.error('worker_dlq_publish_error', { jobId: parsed?.jobId }, dlqErr);
          }

          // ACK poisoned message to prevent blocking the queue
          ch.ack(msg);
        }
      },
      {
        noAck: false,
      }
    );
  } catch (err: any) {
    workerLogger.error('worker_consumer_startup_error', {}, err);
    setTimeout(() => startConsumer().catch(console.error), 5000);
  }
}

