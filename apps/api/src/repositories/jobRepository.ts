import { PoolClient } from 'pg';
import { query } from '../db';
import { JobStatus, JobType, JobStatsSummary } from '@forgeflow/shared';

export interface JobDbRow {
  id: string;
  user_id: string;
  type: JobType;
  payload: Record<string, any>;
  status: JobStatus;
  retry_count: number;
  max_retries: number;
  last_error: string | null;
  next_retry_at: Date | null;
  created_at: Date;
  updated_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  error: string | null;
}

export class JobRepository {
  async create(
    userId: string,
    type: JobType,
    payload: Record<string, any> = {},
    client?: PoolClient
  ): Promise<JobDbRow> {
    const sql = `
      INSERT INTO jobs (user_id, type, payload, status, created_at, updated_at)
      VALUES ($1, $2, $3, 'PENDING', NOW(), NOW())
      RETURNING *
    `;
    const params = [userId, type, JSON.stringify(payload)];

    const res = client
      ? await client.query<JobDbRow>(sql, params)
      : await query<JobDbRow>(sql, params);

    return res.rows[0];
  }

  async findById(
    id: string,
    userId?: string,
    client?: PoolClient
  ): Promise<JobDbRow | null> {
    let sql = 'SELECT * FROM jobs WHERE id = $1';
    const params: any[] = [id];

    if (userId) {
      sql += ' AND user_id = $2';
      params.push(userId);
    }

    const res = client
      ? await client.query<JobDbRow>(sql, params)
      : await query<JobDbRow>(sql, params);

    return res.rows[0] || null;
  }

  async findAllByUser(
    userId: string,
    filters: {
      status?: JobStatus;
      type?: JobType;
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<{ jobs: JobDbRow[]; total: number }> {
    const { status, type, limit = 50, offset = 0 } = filters;

    let whereConditions: string[] = ['user_id = $1'];
    let params: any[] = [userId];
    let paramIndex = 2;

    if (status) {
      whereConditions.push(`status = $${paramIndex++}`);
      params.push(status);
    }

    if (type) {
      whereConditions.push(`type = $${paramIndex++}`);
      params.push(type);
    }

    const whereClause = whereConditions.join(' AND ');

    // Query for total count matching filter
    const countRes = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM jobs WHERE ${whereClause}`,
      params
    );
    const total = parseInt(countRes.rows[0]?.count || '0', 10);

    // Query for paginated jobs
    const dataSql = `
      SELECT * FROM jobs
      WHERE ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `;
    params.push(limit, offset);

    const jobsRes = await query<JobDbRow>(dataSql, params);

    return {
      jobs: jobsRes.rows,
      total,
    };
  }

  async cancel(id: string, userId: string): Promise<JobDbRow | null> {
    // Only jobs with status 'PENDING' can be cancelled in V1
    const res = await query<JobDbRow>(
      `UPDATE jobs
       SET status = 'CANCELLED', updated_at = NOW()
       WHERE id = $1 AND user_id = $2 AND status = 'PENDING'
       RETURNING *`,
      [id, userId]
    );
    return res.rows[0] || null;
  }

  async getStatsByUser(userId: string): Promise<JobStatsSummary> {
    const res = await query<{ status: JobStatus; count: string }>(
      `SELECT status, COUNT(*) as count
       FROM jobs
       WHERE user_id = $1
       GROUP BY status`,
      [userId]
    );

    const stats: JobStatsSummary = {
      total: 0,
      pending: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    };

    for (const row of res.rows) {
      const c = parseInt(row.count, 10);
      stats.total += c;
      if (row.status === 'PENDING') stats.pending = c;
      if (row.status === 'RUNNING') stats.running = c;
      if (row.status === 'COMPLETED') stats.completed = c;
      if (row.status === 'FAILED') stats.failed = c;
      if (row.status === 'CANCELLED') stats.cancelled = c;
    }

    return stats;
  }
}

export const jobRepository = new JobRepository();
