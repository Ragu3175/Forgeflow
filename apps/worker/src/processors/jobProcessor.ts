import {
  JobQueueMessage,
  DEFAULT_MAX_RETRIES,
  classifyError,
  calculateRetryDelay,
  RetryableError,
  NonRetryableError,
  workerJobsProcessedTotal,
  workerJobsFailedTotal,
  jobProcessingDurationSeconds,
  workerDuplicateJobsSkippedTotal,
  workerRetriesScheduledTotal,
  workerDlqMessagesTotal,
} from '@forgeflow/shared';
import { workerDb } from '../db';
import { invalidateJobCache } from '../cache/redis';
import { workerLogger, WORKER_ID } from '../config/logger';

export { WORKER_ID };

export const STALE_EXECUTION_THRESHOLD_SECONDS = 30;

export type ProcessJobResult =
  | { action: 'COMPLETED' }
  | { action: 'RETRY'; delayMs: number; retryCount: number; error: string }
  | { action: 'DLQ'; reason: 'NON_RETRYABLE' | 'MAX_RETRIES_EXHAUSTED'; error: string; retryCount?: number }
  | { action: 'SKIP'; reason: string };

/**
 * Processes a job message from RabbitMQ with durable worker-side idempotency,
 * structured retry state management, and DLQ routing decisions (Phase 6.2).
 */
export async function processJob(message: JobQueueMessage): Promise<ProcessJobResult> {
  const { jobId, type, requestId } = message;
  const log = workerLogger.child({ jobId, requestId });

  log.info('job_received', { type });

  // 1. Fetch job from PostgreSQL
  const existingJob = await workerDb.findJobById(jobId);
  if (!existingJob) {
    log.warn('job_not_found', { reason: 'JOB_NOT_FOUND' });
    workerDuplicateJobsSkippedTotal.inc({ type: type || 'UNKNOWN', reason: 'JOB_NOT_FOUND' });
    return { action: 'SKIP', reason: 'JOB_NOT_FOUND' };
  }

  // 2. Check if job was cancelled
  if (existingJob.status === 'CANCELLED') {
    log.info('job_duplicate_skipped', { reason: 'JOB_CANCELLED' });
    workerDuplicateJobsSkippedTotal.inc({ type: existingJob.type, reason: 'JOB_CANCELLED' });
    return { action: 'SKIP', reason: 'JOB_CANCELLED' };
  }

  // 3. Durable Worker-Side Idempotency Check
  const existingExec = await workerDb.findExecutionByJobId(jobId);
  if (existingExec) {
    // 3A. Already COMPLETED
    if (existingExec.status === 'COMPLETED') {
      log.info('job_duplicate_skipped', {
        reason: 'ALREADY_COMPLETED',
        completedAt: existingExec.completed_at?.toISOString?.() || existingExec.completed_at,
      });
      workerDuplicateJobsSkippedTotal.inc({ type: existingJob.type, reason: 'ALREADY_COMPLETED' });
      await invalidateJobCache(jobId);
      return { action: 'COMPLETED' };
    }

    // 3B. Currently RUNNING
    if (existingExec.status === 'RUNNING') {
      const staleRecovery = await workerDb.claimStaleExecution(
        jobId,
        WORKER_ID,
        STALE_EXECUTION_THRESHOLD_SECONDS
      );

      if (staleRecovery) {
        log.info('job_stale_recovery', {
          previousWorkerId: existingExec.worker_id,
        });
        // Successfully recovered stale lock -> proceed with workload
      } else {
        log.info('job_duplicate_skipped', {
          reason: 'ACTIVE_ON_ANOTHER_WORKER',
          activeWorkerId: existingExec.worker_id,
        });
        workerDuplicateJobsSkippedTotal.inc({ type: existingJob.type, reason: 'ACTIVE_ON_ANOTHER_WORKER' });
        return { action: 'SKIP', reason: 'ACTIVE_ON_ANOTHER_WORKER' };
      }
    } else if (existingExec.status === 'FAILED') {
      // 3C. Previously FAILED -> check if eligible for retry
      const claim = await workerDb.claimExecution(jobId, WORKER_ID);
      if (!claim) {
        log.info('job_duplicate_skipped', { reason: 'CONCURRENT_CLAIM_LOST' });
        workerDuplicateJobsSkippedTotal.inc({ type: existingJob.type, reason: 'CONCURRENT_CLAIM_LOST' });
        return { action: 'SKIP', reason: 'CONCURRENT_CLAIM_LOST' };
      }
      log.debug('job_execution_reclaimed', { previousStatus: 'FAILED' });
    }
  } else {
    // 3D. No execution record -> Atomically claim execution
    const claim = await workerDb.claimExecution(jobId, WORKER_ID);
    if (!claim) {
      // Another concurrent worker claimed it in a race condition
      const currentExec = await workerDb.findExecutionByJobId(jobId);
      if (currentExec?.status === 'COMPLETED') {
        log.info('job_duplicate_skipped', { reason: 'COMPLETED_BY_CONCURRENT_WORKER' });
        workerDuplicateJobsSkippedTotal.inc({ type: existingJob.type, reason: 'COMPLETED_BY_CONCURRENT_WORKER' });
        await invalidateJobCache(jobId);
        return { action: 'COMPLETED' };
      } else {
        log.info('job_duplicate_skipped', { reason: 'CONCURRENT_CLAIM_LOST' });
        workerDuplicateJobsSkippedTotal.inc({ type: existingJob.type, reason: 'CONCURRENT_CLAIM_LOST' });
        return { action: 'SKIP', reason: 'CONCURRENT_CLAIM_LOST' };
      }
    }
    log.debug('job_execution_claimed');
  }

  // 4. Mark job as RUNNING in jobs table & invalidate cache
  await workerDb.markJobRunning(jobId);
  await invalidateJobCache(jobId);

  // 5. Execute workload with Error Classification & Retry Policy
  const execStartTime = Date.now();
  log.info('job_execution_started', { type });

  try {
    // Check payload for test hooks (e.g. simulated network/payload errors)
    const payload = typeof existingJob.payload === 'string'
      ? JSON.parse(existingJob.payload)
      : existingJob.payload || {};

    if (payload.shouldFail) {
      if (payload.errorType === 'NON_RETRYABLE' || payload.errorMessage?.includes('invalid')) {
        throw new NonRetryableError(payload.errorMessage || 'Invalid payload configuration');
      } else {
        throw new RetryableError(payload.errorMessage || 'Temporary network timeout connecting to upstream');
      }
    }

    // Default simulated workload (2.5 seconds)
    await new Promise((resolve) => setTimeout(resolve, 2500));

    // 6. Check if job was cancelled during processing
    const checkCurrent = await workerDb.findJobById(jobId);
    if (checkCurrent && checkCurrent.status === 'CANCELLED') {
      log.info('job_duplicate_skipped', { reason: 'JOB_CANCELLED_MID_FLIGHT' });
      workerDuplicateJobsSkippedTotal.inc({ type: existingJob.type, reason: 'JOB_CANCELLED_MID_FLIGHT' });
      await invalidateJobCache(jobId);
      return { action: 'SKIP', reason: 'JOB_CANCELLED_MID_FLIGHT' };
    }

    // 7. Transition RUNNING -> COMPLETED atomically in PostgreSQL transaction
    await workerDb.completeJobAndExecution(jobId);
    await invalidateJobCache(jobId);
    const durationMs = Date.now() - execStartTime;

    // Record Metrics for Completed Job (Phase 9.2)
    workerJobsProcessedTotal.inc({ type: existingJob.type, status: 'COMPLETED' });
    jobProcessingDurationSeconds.observe({ type: existingJob.type, status: 'COMPLETED' }, durationMs / 1000);

    log.info('job_execution_completed', { durationMs });
    return { action: 'COMPLETED' };
  } catch (err: any) {
    const errorCategory = classifyError(err);
    const errorMessage = err?.message || 'Unknown processing failure';
    const currentRetryCount = existingJob.retry_count ?? 0;
    const maxRetries = existingJob.max_retries ?? DEFAULT_MAX_RETRIES;
    const durationMs = Date.now() - execStartTime;

    // Record Metrics for Failure / Duration (Phase 9.2)
    workerJobsFailedTotal.inc({ type: existingJob.type, error_category: errorCategory });
    jobProcessingDurationSeconds.observe({ type: existingJob.type, status: 'FAILED' }, durationMs / 1000);

    log.error('job_execution_failed', {
      errorCategory,
      durationMs,
      retryCount: currentRetryCount,
    }, err);

    if (errorCategory === 'NON_RETRYABLE') {
      // Non-retryable error: Mark FAILED immediately and route to DLQ
      await workerDb.recordNonRetryableFailure(jobId, errorMessage);
      await invalidateJobCache(jobId);

      workerDlqMessagesTotal.inc({ type: existingJob.type, reason: 'NON_RETRYABLE' });

      log.warn('job_sent_to_dlq', {
        reason: 'NON_RETRYABLE',
        error: errorMessage,
        retryCount: currentRetryCount,
      });

      return {
        action: 'DLQ',
        reason: 'NON_RETRYABLE',
        error: errorMessage,
        retryCount: currentRetryCount,
      };
    }

    // Retryable error: Check if retry limit is exhausted
    if (currentRetryCount < maxRetries) {
      const delayMs = calculateRetryDelay(currentRetryCount);
      const nextRetryAt = new Date(Date.now() + delayMs);
      const newRetryCount = currentRetryCount + 1;

      await workerDb.recordRetryableFailure(jobId, errorMessage, nextRetryAt);
      await invalidateJobCache(jobId);

      workerRetriesScheduledTotal.inc({ type: existingJob.type });

      log.info('job_retry_scheduled', {
        retryCount: newRetryCount,
        maxRetries,
        delayMs,
        nextRetryAt: nextRetryAt.toISOString(),
      });

      return {
        action: 'RETRY',
        delayMs,
        retryCount: newRetryCount,
        error: errorMessage,
      };
    } else {
      // Retries exhausted
      const exhaustedMsg = `Max retries exhausted (${maxRetries}/${maxRetries}): ${errorMessage}`;
      await workerDb.recordNonRetryableFailure(jobId, exhaustedMsg);
      await invalidateJobCache(jobId);

      workerDlqMessagesTotal.inc({ type: existingJob.type, reason: 'MAX_RETRIES_EXHAUSTED' });

      log.warn('job_sent_to_dlq', {
        reason: 'MAX_RETRIES_EXHAUSTED',
        error: errorMessage,
        retryCount: maxRetries,
      });

      return {
        action: 'DLQ',
        reason: 'MAX_RETRIES_EXHAUSTED',
        error: errorMessage,
        retryCount: maxRetries,
      };
    }
  }
}


