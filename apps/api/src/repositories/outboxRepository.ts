import { PoolClient } from 'pg';
import { query } from '../db';
import { OutboxEventStatus, OutboxEventType } from '@forgeflow/shared';

export interface OutboxEventDbRow {
  id: string;
  event_type: OutboxEventType | string;
  aggregate_type: string;
  aggregate_id: string;
  payload: Record<string, any>;
  status: OutboxEventStatus;
  attempts: number;
  available_at: Date;
  published_at: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreateOutboxEventParams {
  eventType: OutboxEventType | string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, any>;
}

export class OutboxRepository {
  /**
   * Inserts an outbox event atomically as part of a transaction.
   */
  async create(
    params: CreateOutboxEventParams,
    client?: PoolClient
  ): Promise<OutboxEventDbRow> {
    const sql = `
      INSERT INTO outbox_events (
        event_type,
        aggregate_type,
        aggregate_id,
        payload,
        status,
        attempts,
        available_at,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, 'PENDING', 0, NOW(), NOW(), NOW())
      RETURNING *
    `;
    const values = [
      params.eventType,
      params.aggregateType,
      params.aggregateId,
      JSON.stringify(params.payload),
    ];

    const res = client
      ? await client.query<OutboxEventDbRow>(sql, values)
      : await query<OutboxEventDbRow>(sql, values);

    return res.rows[0];
  }

  /**
   * Atomically claims a batch of pending or failed (retryable) outbox events using FOR UPDATE SKIP LOCKED.
   * This guarantees that concurrent publisher instances will never process or lock the same event.
   */
  async claimPendingEvents(
    batchSize: number,
    client: PoolClient
  ): Promise<OutboxEventDbRow[]> {
    const sql = `
      SELECT *
      FROM outbox_events
      WHERE status IN ('PENDING', 'FAILED')
        AND available_at <= NOW()
      ORDER BY created_at ASC
      LIMIT $1
      FOR UPDATE SKIP LOCKED
    `;
    const res = await client.query<OutboxEventDbRow>(sql, [batchSize]);
    return res.rows;
  }

  /**
   * Marks an outbox event as successfully PUBLISHED.
   */
  async markPublished(id: string, client?: PoolClient): Promise<void> {
    const sql = `
      UPDATE outbox_events
      SET status = 'PUBLISHED',
          published_at = NOW(),
          updated_at = NOW(),
          last_error = NULL
      WHERE id = $1
    `;
    if (client) {
      await client.query(sql, [id]);
    } else {
      await query(sql, [id]);
    }
  }

  /**
   * Records a failed publishing attempt, increments attempt counter, and schedules next retry time.
   */
  async recordPublishFailure(
    id: string,
    errorMessage: string,
    nextAvailableAt: Date,
    client?: PoolClient
  ): Promise<void> {
    const sql = `
      UPDATE outbox_events
      SET status = 'FAILED',
          attempts = attempts + 1,
          last_error = $2,
          available_at = $3,
          updated_at = NOW()
      WHERE id = $1
    `;
    const values = [id, errorMessage, nextAvailableAt];
    if (client) {
      await client.query(sql, values);
    } else {
      await query(sql, values);
    }
  }

  /**
   * Finds an outbox event by ID.
   */
  async findById(id: string, client?: PoolClient): Promise<OutboxEventDbRow | null> {
    const sql = 'SELECT * FROM outbox_events WHERE id = $1';
    const res = client
      ? await client.query<OutboxEventDbRow>(sql, [id])
      : await query<OutboxEventDbRow>(sql, [id]);
    return res.rows[0] || null;
  }

  /**
   * Finds outbox events for a specific aggregate.
   */
  async findByAggregate(
    aggregateType: string,
    aggregateId: string,
    client?: PoolClient
  ): Promise<OutboxEventDbRow[]> {
    const sql = `
      SELECT * FROM outbox_events
      WHERE aggregate_type = $1 AND aggregate_id = $2
      ORDER BY created_at ASC
    `;
    const res = client
      ? await client.query<OutboxEventDbRow>(sql, [aggregateType, aggregateId])
      : await query<OutboxEventDbRow>(sql, [aggregateType, aggregateId]);
    return res.rows;
  }
}

export const outboxRepository = new OutboxRepository();
