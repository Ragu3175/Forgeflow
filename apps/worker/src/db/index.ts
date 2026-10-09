import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { env } from '../config/env';
import { JobStatus } from '@forgeflow/shared';

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('[Worker DB Pool Error]:', err.message);
});

export async function query<T extends QueryResultRow = any>(
  text: string,
  params?: any[]
): Promise<QueryResult<T>> {
  return pool.query<T>(text, params);
}

export async function withTransaction<T>(
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export interface JobRecord {
  id: string;
  user_id: string;
  type: string;
  payload: any;
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

export interface JobExecutionRecord {
  id: string;
  job_id: string;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED';
  worker_id: string | null;
  started_at: Date;
  completed_at: Date | null;
  error: string | null;
  updated_at: Date;
}

export const workerDb = {
  /**
   * Fetches the job record from PostgreSQL.
   */
  async findJobById(jobId: string, client?: PoolClient): Promise<JobRecord | null> {
    const sql = 'SELECT * FROM jobs WHERE id = $1';
    const params = [jobId];
    const res = client
      ? await client.query<JobRecord>(sql, params)
      : await query<JobRecord>(sql, params);
    return res.rows[0] || null;
  },

  /**
   * Fetches the durable execution record for a job.
   */
  async findExecutionByJobId(
    jobId: string,
    client?: PoolClient
  ): Promise<JobExecutionRecord | null> {
    const sql = 'SELECT * FROM job_executions WHERE job_id = $1';
    const params = [jobId];
    const res = client
      ? await client.query<JobExecutionRecord>(sql, params)
      : await query<JobExecutionRecord>(sql, params);
    return res.rows[0] || null;
  },

  /**
   * Attempts to atomically claim the execution of a job using UNIQUE(job_id).
   * If a record already exists with status 'FAILED', allows re-claiming it as 'RUNNING'.
   * Returns the execution record if this worker won the claim, or null if actively claimed/completed.
   */
  async claimExecution(
    jobId: string,
    workerId: string,
    client?: PoolClient
  ): Promise<JobExecutionRecord | null> {
    const sql = `
      INSERT INTO job_executions (job_id, status, worker_id, started_at, updated_at)
      VALUES ($1, 'RUNNING', $2, NOW(), NOW())
      ON CONFLICT (job_id)
      DO UPDATE SET status = 'RUNNING', worker_id = $2, started_at = NOW(), updated_at = NOW(), error = NULL
      WHERE job_executions.status = 'FAILED'
      RETURNING *
    `;
    const params = [jobId, workerId];
    const res = client
      ? await client.query<JobExecutionRecord>(sql, params)
      : await query<JobExecutionRecord>(sql, params);
    return res.rows[0] || null;
  },

  /**
   * Attempts to recover a stale execution stuck in RUNNING status past the threshold.
   */
  async claimStaleExecution(
    jobId: string,
    workerId: string,
    staleThresholdSeconds: number = 30,
    client?: PoolClient
  ): Promise<JobExecutionRecord | null> {
    const sql = `
      UPDATE job_executions
      SET worker_id = $2, started_at = NOW(), updated_at = NOW()
      WHERE job_id = $1 
        AND status = 'RUNNING' 
        AND updated_at < NOW() - ($3 || ' seconds')::interval
      RETURNING *
    `;
    const params = [jobId, workerId, staleThresholdSeconds];
    const res = client
      ? await client.query<JobExecutionRecord>(sql, params)
      : await query<JobExecutionRecord>(sql, params);
    return res.rows[0] || null;
  },

  /**
   * Marks a job as RUNNING in the jobs table.
   */
  async markJobRunning(jobId: string, client?: PoolClient): Promise<JobRecord | null> {
    const sql = `
      UPDATE jobs
      SET status = 'RUNNING', started_at = COALESCE(started_at, NOW()), updated_at = NOW()
      WHERE id = $1 AND status IN ('PENDING', 'RUNNING')
      RETURNING *
    `;
    const params = [jobId];
    const res = client
      ? await client.query<JobRecord>(sql, params)
      : await query<JobRecord>(sql, params);
    return res.rows[0] || null;
  },

  /**
   * Atomically marks both job_executions and jobs as COMPLETED in a single transaction.
   */
  async completeJobAndExecution(jobId: string): Promise<{ job: JobRecord; execution: JobExecutionRecord }> {
    return withTransaction(async (client) => {
      // 1. Update job_executions
      const execRes = await client.query<JobExecutionRecord>(
        `UPDATE job_executions
         SET status = 'COMPLETED', completed_at = NOW(), updated_at = NOW(), error = NULL
         WHERE job_id = $1
         RETURNING *`,
        [jobId]
      );

      // 2. Update jobs
      const jobRes = await client.query<JobRecord>(
        `UPDATE jobs
         SET status = 'COMPLETED', completed_at = NOW(), next_retry_at = NULL, updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [jobId]
      );

      return {
        execution: execRes.rows[0],
        job: jobRes.rows[0],
      };
    });
  },

  /**
   * Records a retryable failure: increments retry_count, schedules next_retry_at,
   * stores last_error, and updates job_executions to FAILED.
   */
  async recordRetryableFailure(
    jobId: string,
    errorMessage: string,
    nextRetryAt: Date
  ): Promise<JobRecord | null> {
    return withTransaction(async (client) => {
      await client.query(
        `INSERT INTO job_executions (job_id, status, error, started_at, updated_at)
         VALUES ($1, 'FAILED', $2, NOW(), NOW())
         ON CONFLICT (job_id) 
         DO UPDATE SET status = 'FAILED', error = $2, updated_at = NOW()`,
        [jobId, errorMessage]
      );

      const jobRes = await client.query<JobRecord>(
        `UPDATE jobs
         SET status = 'PENDING',
             retry_count = retry_count + 1,
             last_error = $2,
             next_retry_at = $3,
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [jobId, errorMessage, nextRetryAt]
      );

      return jobRes.rows[0] || null;
    });
  },

  /**
   * Records a permanent / non-retryable failure or retry exhaustion:
   * updates status to FAILED, records last_error, clears next_retry_at.
   */
  async recordNonRetryableFailure(
    jobId: string,
    errorMessage: string
  ): Promise<JobRecord | null> {
    return withTransaction(async (client) => {
      await client.query(
        `INSERT INTO job_executions (job_id, status, error, started_at, updated_at)
         VALUES ($1, 'FAILED', $2, NOW(), NOW())
         ON CONFLICT (job_id) 
         DO UPDATE SET status = 'FAILED', error = $2, updated_at = NOW()`,
        [jobId, errorMessage]
      );

      const jobRes = await client.query<JobRecord>(
        `UPDATE jobs
         SET status = 'FAILED',
             last_error = $2,
             next_retry_at = NULL,
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [jobId, errorMessage]
      );

      return jobRes.rows[0] || null;
    });
  },

  /**
   * Legacy failure helper for general errors.
   */
  async failJobAndExecution(jobId: string, errorMessage: string): Promise<void> {
    await this.recordNonRetryableFailure(jobId, errorMessage);
  },
};
