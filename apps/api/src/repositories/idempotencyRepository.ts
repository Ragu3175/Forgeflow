import { PoolClient } from 'pg';
import { query } from '../db';

export interface IdempotencyKeyDbRow {
  id: string;
  key: string;
  user_id: string;
  job_id: string;
  created_at: Date;
}

export class IdempotencyRepository {
  /**
   * Finds an existing idempotency record by authenticated user ID and key.
   */
  async findByUserAndKey(
    userId: string,
    key: string,
    client?: PoolClient
  ): Promise<IdempotencyKeyDbRow | null> {
    const sql = `
      SELECT * FROM idempotency_keys
      WHERE user_id = $1 AND key = $2
    `;
    const params = [userId, key];

    const res = client
      ? await client.query<IdempotencyKeyDbRow>(sql, params)
      : await query<IdempotencyKeyDbRow>(sql, params);

    return res.rows[0] || null;
  }

  /**
   * Inserts a new idempotency key record associated with a created job.
   */
  async create(
    userId: string,
    key: string,
    jobId: string,
    client?: PoolClient
  ): Promise<IdempotencyKeyDbRow> {
    const sql = `
      INSERT INTO idempotency_keys (user_id, key, job_id, created_at)
      VALUES ($1, $2, $3, NOW())
      RETURNING *
    `;
    const params = [userId, key, jobId];

    const res = client
      ? await client.query<IdempotencyKeyDbRow>(sql, params)
      : await query<IdempotencyKeyDbRow>(sql, params);

    return res.rows[0];
  }
}

export const idempotencyRepository = new IdempotencyRepository();
