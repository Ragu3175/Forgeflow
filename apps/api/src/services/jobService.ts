import {
  Job,
  JobStatus,
  JobType,
  CreateJobDto,
  JobsListQuery,
  JobsListResponse,
  JobStatsSummary,
  jobsCreatedTotal,
  jobsCompletedTotal,
  jobsFailedTotal,
  injectTraceContext,
} from '@forgeflow/shared';
import { jobRepository, JobDbRow } from '../repositories/jobRepository';
import { idempotencyRepository } from '../repositories/idempotencyRepository';
import { outboxRepository } from '../repositories/outboxRepository';
import { outboxPublisher } from '../outbox/outboxPublisher';
import { withTransaction } from '../db';
import { apiLogger } from '../middlewares/correlationMiddleware';
import {
  getJobCache,
  setJobCache,
  deleteJobCache,
  DEFAULT_JOB_CACHE_TTL_SECONDS,
} from '../cache/jobCache';

export interface CreateJobResult {
  job: Job;
  isIdempotentReplay: boolean;
}

export class JobService {
  private formatJob(row: JobDbRow): Job {
    return {
      id: row.id,
      userId: row.user_id,
      type: row.type,
      payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
      status: row.status,
      retryCount: row.retry_count ?? 0,
      maxRetries: row.max_retries ?? 3,
      lastError: row.last_error ?? null,
      nextRetryAt: row.next_retry_at ? row.next_retry_at.toISOString() : null,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      startedAt: row.started_at ? row.started_at.toISOString() : null,
      completedAt: row.completed_at ? row.completed_at.toISOString() : null,
      error: row.error,
    };
  }

  async createJob(
    userId: string,
    dto: CreateJobDto,
    idempotencyKey: string,
    requestId?: string
  ): Promise<CreateJobResult> {
    // 1. Fast path: check if idempotency record already exists for this (user_id, key)
    const existingRecord = await idempotencyRepository.findByUserAndKey(
      userId,
      idempotencyKey
    );

    if (existingRecord) {
      const existingJobRow = await jobRepository.findById(
        existingRecord.job_id,
        userId
      );
      if (existingJobRow) {
        apiLogger.info('idempotency_hit', {
          key: idempotencyKey,
          userId,
          jobId: existingRecord.job_id,
          requestId,
        }, `Replayed request with key '${idempotencyKey}' for user '${userId}'. Returning existing job ${existingRecord.job_id}`);

        return {
          job: this.formatJob(existingJobRow),
          isIdempotentReplay: true,
        };
      }
    }

    // 2. Perform atomic insert of Job + Idempotency Key + Outbox Event in a single PostgreSQL transaction (Phase 7)
    try {
      const createdJobRow = await withTransaction(async (client) => {
        // 2a. Insert job with status PENDING
        const jobRow = await jobRepository.create(
          userId,
          dto.type,
          dto.payload || {},
          client
        );

        // 2b. Insert idempotency key record associated with the created job
        await idempotencyRepository.create(
          userId,
          idempotencyKey,
          jobRow.id,
          client
        );

        // 2c. Atomically insert outbox event with correlation & trace metadata (Phase 9.4)
        const traceHeaders: Record<string, string> = {};
        injectTraceContext(traceHeaders);

        const outboxEvent = await outboxRepository.create(
          {
            eventType: 'JOB_CREATED',
            aggregateType: 'JOB',
            aggregateId: jobRow.id,
            payload: {
              jobId: jobRow.id,
              type: jobRow.type,
              timestamp: jobRow.created_at.toISOString(),
              requestId,
              traceparent: traceHeaders.traceparent,
              tracestate: traceHeaders.tracestate,
            },
          },
          client
        );

        // Log outbox_event_created within transaction context
        apiLogger.info('outbox_event_created', {
          eventId: outboxEvent.id,
          jobId: jobRow.id,
          requestId,
          eventType: 'JOB_CREATED',
        });

        return jobRow;
      });

      const job = this.formatJob(createdJobRow);

      // Log job_created
      apiLogger.info('job_created', {
        jobId: job.id,
        requestId,
        userId,
        type: job.type,
        status: job.status,
      });

      // Increment Prometheus Counter for Job Creation (Phase 9.2)
      jobsCreatedTotal.inc({
        type: job.type,
        status: job.status,
      });

      // 3. Trigger Outbox Publisher asynchronously (non-blocking immediate dispatch)
      outboxPublisher.trigger().catch((pubErr) => {
        apiLogger.warn('outbox_trigger_notice', { error: pubErr.message, jobId: job.id, requestId });
      });

      // 4. Return created job immediately to client without waiting for worker processing
      return {
        job,
        isIdempotentReplay: false,
      };
    } catch (err: any) {
      // 5. Concurrency handling:
      // If a concurrent request with the same (user_id, idempotencyKey) won the race and committed,
      // the unique constraint 'uq_idempotency_keys_user_key' triggers error code 23505.
      if (
        err.code === '23505' &&
        (err.constraint === 'uq_idempotency_keys_user_key' ||
          err.detail?.includes('key') ||
          err.message?.includes('uq_idempotency_keys_user_key'))
      ) {
        apiLogger.info('idempotency_race_conflict', {
          key: idempotencyKey,
          userId,
          requestId,
        }, `Concurrent request detected for key '${idempotencyKey}' by user '${userId}'. Fetching committed job...`);

        const record = await idempotencyRepository.findByUserAndKey(
          userId,
          idempotencyKey
        );
        if (record) {
          const jobRow = await jobRepository.findById(record.job_id, userId);
          if (jobRow) {
            return {
              job: this.formatJob(jobRow),
              isIdempotentReplay: true,
            };
          }
        }
      }

      throw err;
    }
  }

  async getJobs(userId: string, query: JobsListQuery): Promise<JobsListResponse> {
    const { jobs: rows, total } = await jobRepository.findAllByUser(userId, {
      status: query.status,
      type: query.type,
      limit: query.limit,
      offset: query.offset,
    });

    const stats = await jobRepository.getStatsByUser(userId);

    return {
      jobs: rows.map((r) => this.formatJob(r)),
      total,
      stats,
    };
  }

  async getJobById(id: string, userId: string): Promise<Job> {
    // 1. Try fetching from Redis Cache first
    const cachedJob = await getJobCache(id);
    if (cachedJob) {
      if (cachedJob.userId === userId) {
        apiLogger.info('cache_hit', { jobId: id, userId });
        return cachedJob;
      } else {
        // User mismatch: job exists but belongs to another user
        const error: any = new Error(`Job with ID '${id}' was not found.`);
        error.statusCode = 404;
        throw error;
      }
    }

    apiLogger.info('cache_miss', { jobId: id, userId });

    // 2. Query PostgreSQL (Source of Truth)
    const row = await jobRepository.findById(id, userId);
    if (!row) {
      const error: any = new Error(`Job with ID '${id}' was not found.`);
      error.statusCode = 404;
      throw error;
    }

    const job = this.formatJob(row);

    // 3. Store result in Redis Cache with 30s TTL
    await setJobCache(job.id, job, DEFAULT_JOB_CACHE_TTL_SECONDS);
    apiLogger.debug('cache_stored', { jobId: id, ttl: DEFAULT_JOB_CACHE_TTL_SECONDS });

    return job;
  }

  async cancelJob(id: string, userId: string): Promise<Job> {
    // Check if job exists
    const existing = await jobRepository.findById(id, userId);
    if (!existing) {
      const error: any = new Error(`Job with ID '${id}' was not found.`);
      error.statusCode = 404;
      throw error;
    }

    if (existing.status !== 'PENDING') {
      const error: any = new Error(
        `Cannot cancel job with status '${existing.status}'. Only PENDING jobs can be cancelled.`
      );
      error.statusCode = 400;
      throw error;
    }

    const updated = await jobRepository.cancel(id, userId);
    if (!updated) {
      const error: any = new Error('Failed to cancel job.');
      error.statusCode = 500;
      throw error;
    }

    const job = this.formatJob(updated);

    // Invalidate Redis cache for this job
    await deleteJobCache(id);
    apiLogger.info('job_cancelled', { jobId: id, userId });

    return job;
  }

  async getJobStats(userId: string): Promise<JobStatsSummary> {
    return jobRepository.getStatsByUser(userId);
  }
}

export const jobService = new JobService();

