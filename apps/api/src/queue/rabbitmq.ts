import amqp, { Channel, ChannelModel } from 'amqplib';
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
  injectTraceContext,
} from '@forgeflow/shared';

let connection: ChannelModel | null = null;
let channel: Channel | null = null;
let isConnected = false;

/**
 * Initializes connection and channel to RabbitMQ.
 * Asserts the full ForgeFlow topology:
 * 1. DLX exchange & DLQ queue
 * 2. Retry exchange & Delay queue (with dead-letter routing to main queue)
 * 3. Main 'forgeflow.jobs' queue
 */
export async function connectRabbitMQ(): Promise<boolean> {
  try {
    console.log(`[RabbitMQ] Connecting to RabbitMQ at ${env.RABBITMQ_URL}...`);
    const conn = await amqp.connect(env.RABBITMQ_URL);
    connection = conn;

    (conn as any).on('error', (err: any) => {
      console.error('[RabbitMQ Connection Error]:', err?.message || err);
      isConnected = false;
    });

    (conn as any).on('close', () => {
      console.warn('[RabbitMQ] Connection closed.');
      isConnected = false;
    });

    const ch = await conn.createChannel();
    channel = ch;

    ch.on('error', (err: any) => {
      console.error('[RabbitMQ Channel Error]:', err?.message || err);
    });

    ch.on('close', () => {
      console.warn('[RabbitMQ] Channel closed.');
    });

    // 1. Assert Dead Letter Exchange & DLQ
    await ch.assertExchange(FORGEFLOW_DLX_EXCHANGE, 'direct', { durable: true });
    await ch.assertQueue(FORGEFLOW_DLQ_QUEUE, { durable: true });
    await ch.bindQueue(FORGEFLOW_DLQ_QUEUE, FORGEFLOW_DLX_EXCHANGE, FORGEFLOW_DLQ_ROUTING_KEY);

    // 2. Assert Retry Exchange & Delay Queue (dead-letters back to default exchange -> forgeflow.jobs)
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

    isConnected = true;
    console.log(
      `[RabbitMQ] ✅ Connected and asserted topology: Main ('${FORGEFLOW_JOBS_QUEUE}'), Retry ('${FORGEFLOW_RETRY_QUEUE}'), DLQ ('${FORGEFLOW_DLQ_QUEUE}')`
    );
    return true;
  } catch (err: any) {
    isConnected = false;
    console.warn(`[RabbitMQ Warning] Failed to connect to RabbitMQ at ${env.RABBITMQ_URL}: ${err.message}`);
    console.warn('[RabbitMQ Warning] API will continue running without message dispatch.');
    return false;
  }
}

/**
 * Publishes a job message to the durable 'forgeflow.jobs' queue with persistent delivery.
 */
export async function publishJobMessage(message: JobQueueMessage): Promise<boolean> {
  try {
    if (!channel || !isConnected) {
      console.warn('[RabbitMQ Warning] Channel unavailable, attempting to reconnect...');
      const reconnected = await connectRabbitMQ();
      if (!reconnected || !channel) {
        console.error(`[RabbitMQ Error] Failed to publish message for job ${message.jobId}: No active channel.`);
        return false;
      }
    }

    const headers: Record<string, any> = {
      'x-request-id': message.requestId,
    };
    if (message.traceparent) {
      headers.traceparent = message.traceparent;
    }
    if (message.tracestate) {
      headers.tracestate = message.tracestate;
    }
    injectTraceContext(headers);

    const payloadBuffer = Buffer.from(JSON.stringify(message));
    const published = channel.sendToQueue(FORGEFLOW_JOBS_QUEUE, payloadBuffer, {
      persistent: true,
      contentType: 'application/json',
      headers,
    });

    if (published) {
      console.log(`[RabbitMQ] 📨 Published message to '${FORGEFLOW_JOBS_QUEUE}' for Job ${message.jobId}`);
    } else {
      console.warn(`[RabbitMQ Warning] Message for Job ${message.jobId} was queued in client buffer.`);
    }

    return published;
  } catch (err: any) {
    console.error(`[RabbitMQ Error] Failed to publish message for Job ${message.jobId}:`, err.message);
    return false;
  }
}

export function isRabbitMQReady(): boolean {
  return isConnected && channel !== null;
}

/**
 * Queries the current queue depth for a given RabbitMQ queue.
 */
export async function getQueueDepth(queueName: string = FORGEFLOW_JOBS_QUEUE): Promise<number | null> {
  try {
    if (!channel || !isConnected) return null;
    const ok = await channel.checkQueue(queueName);
    return ok.messageCount;
  } catch {
    return null;
  }
}

/**
 * Closes the RabbitMQ channel and connection gracefully.
 */
export async function closeRabbitMQ(): Promise<void> {
  try {
    if (channel) {
      await channel.close();
      channel = null;
    }
    if (connection) {
      await connection.close();
      connection = null;
    }
    isConnected = false;
    console.log('[RabbitMQ] Closed channel and connection gracefully.');
  } catch (err: any) {
    console.warn('[RabbitMQ Warning] Error while closing RabbitMQ:', err.message);
  }
}


