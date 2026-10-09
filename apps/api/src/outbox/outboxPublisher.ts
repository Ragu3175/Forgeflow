import { pool } from '../db';
import { outboxRepository } from '../repositories/outboxRepository';
import { publishJobMessage } from '../queue/rabbitmq';
import { apiLogger } from '../middlewares/correlationMiddleware';
import { extractTraceContext, withSpan, SpanKind } from '@forgeflow/shared';

export class OutboxPublisher {
  private timer: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private isRunning = false;
  private pollIntervalMs: number;

  constructor(pollIntervalMs: number = 1000) {
    this.pollIntervalMs = pollIntervalMs;
  }

  /**
   * Processes a single batch of available outbox events atomically.
   * Uses SELECT FOR UPDATE SKIP LOCKED inside a transaction to guarantee exclusive claims.
   * Returns the count of processed events in this batch.
   */
  async processBatch(batchSize: number = 20): Promise<number> {
    const client = await pool.connect();
    let processedCount = 0;

    try {
      await client.query('BEGIN');

      // 1. Claim available events with row-level locks that skip locked rows
      const events = await outboxRepository.claimPendingEvents(batchSize, client);

      if (events.length === 0) {
        await client.query('COMMIT');
        return 0;
      }

      // 2. Publish each claimed event to RabbitMQ
      for (const event of events) {
        let payload: any = null;
        try {
          payload =
            typeof event.payload === 'string'
              ? JSON.parse(event.payload)
              : event.payload;

          const parentCtx = payload?.traceparent
            ? extractTraceContext({
                traceparent: payload.traceparent,
                tracestate: payload.tracestate,
              })
            : undefined;

          await withSpan(
            `outbox_publish ${event.event_type}`,
            async (span) => {
              span.setAttributes({
                'messaging.system': 'rabbitmq',
                'messaging.destination.name': 'forgeflow.jobs',
                'job.id': event.aggregate_id,
                'event.id': event.id,
                'event.type': event.event_type,
              });

              const pubStart = Date.now();
              if (event.event_type === 'JOB_CREATED') {
                const published = await publishJobMessage(payload);
                if (!published) {
                  throw new Error('RabbitMQ channel returned false or connection was unavailable');
                }
              }

              // 3. Mark event as PUBLISHED in the same database transaction
              await outboxRepository.markPublished(event.id, client);
              processedCount++;
              const durationMs = Date.now() - pubStart;

              apiLogger.info('outbox_event_published', {
                eventId: event.id,
                jobId: event.aggregate_id,
                requestId: payload?.requestId,
                eventType: event.event_type,
                durationMs,
              });
            },
            {
              kind: SpanKind.PRODUCER,
            },
            parentCtx
          );
        } catch (err: any) {
          // Calculate exponential backoff for publisher retries (1s, 2s, 4s, 8s, max 30s)
          const delayMs = Math.min(1000 * Math.pow(2, event.attempts), 30000);
          const nextAvailableAt = new Date(Date.now() + delayMs);

          await outboxRepository.recordPublishFailure(
            event.id,
            err.message || 'Publishing error',
            nextAvailableAt,
            client
          );

          apiLogger.error('outbox_publish_failed', {
            eventId: event.id,
            jobId: event.aggregate_id,
            requestId: payload?.requestId,
            eventType: event.event_type,
            attempt: event.attempts + 1,
            nextAvailableAt: nextAvailableAt.toISOString(),
          }, err);
        }
      }

      await client.query('COMMIT');
      return processedCount;
    } catch (err: any) {
      await client.query('ROLLBACK');
      apiLogger.error('outbox_batch_error', {}, err);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Triggers an immediate execution cycle without waiting for the timer tick.
   * Useful right after a new job transaction commits.
   */
  async trigger(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;
    try {
      let count = 0;
      do {
        count = await this.processBatch();
      } while (count > 0);
    } catch (err: any) {
      apiLogger.error('outbox_trigger_error', {}, err);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Starts the background polling loop.
   */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    apiLogger.info('outbox_publisher_started', { pollIntervalMs: this.pollIntervalMs });

    const loop = async () => {
      if (!this.isRunning) return;
      await this.trigger();
      if (this.isRunning) {
        this.timer = setTimeout(loop, this.pollIntervalMs);
      }
    };

    // Kick off immediate first loop
    this.timer = setTimeout(loop, 100);
  }

  /**
   * Stops the background publisher loop gracefully.
   */
  stop(): void {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    apiLogger.info('outbox_publisher_stopped');
  }
}

export const outboxPublisher = new OutboxPublisher();

