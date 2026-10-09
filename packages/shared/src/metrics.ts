import {
  Registry,
  Counter,
  Histogram,
  Gauge,
  collectDefaultMetrics,
} from 'prom-client';

// ============================================================================
// Registry Setup
// ============================================================================

export const register = new Registry();

// Collect standard Node.js runtime metrics (CPU, memory, event loop, GC)
collectDefaultMetrics({
  register,
  prefix: 'forgeflow_',
});

// ============================================================================
// 1. API HTTP Metrics
// ============================================================================

/**
 * Total count of HTTP requests processed by ForgeFlow API.
 * Labels: method, route, status_code (Low Cardinality)
 */
export const httpRequestsTotal = new Counter({
  name: 'forgeflow_http_requests_total',
  help: 'Total number of HTTP requests processed by ForgeFlow API.',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
});

/**
 * Latency distribution of HTTP requests in seconds.
 * Labels: method, route, status_code (Low Cardinality)
 */
export const httpRequestDurationSeconds = new Histogram({
  name: 'forgeflow_http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds.',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

/**
 * Total count of background jobs created via API.
 * Labels: type, status (e.g. type='PDF_GENERATION', status='PENDING')
 */
export const jobsCreatedTotal = new Counter({
  name: 'forgeflow_jobs_created_total',
  help: 'Total number of jobs created via ForgeFlow API.',
  labelNames: ['type', 'status'],
  registers: [register],
});

/**
 * Total count of jobs completed observed API-side.
 * Labels: type
 */
export const jobsCompletedTotal = new Counter({
  name: 'forgeflow_jobs_completed_total',
  help: 'Total number of jobs completed observed by API-side logic.',
  labelNames: ['type'],
  registers: [register],
});

/**
 * Total count of jobs failed observed API-side.
 * Labels: type
 */
export const jobsFailedTotal = new Counter({
  name: 'forgeflow_jobs_failed_total',
  help: 'Total number of jobs failed observed by API-side logic.',
  labelNames: ['type'],
  registers: [register],
});

/**
 * Current queue depth / backlog count in RabbitMQ.
 * Labels: queue
 */
export const queueDepthGauge = new Gauge({
  name: 'forgeflow_queue_depth',
  help: 'Current number of messages in the RabbitMQ queue.',
  labelNames: ['queue'],
  registers: [register],
});

// ============================================================================
// 2. Worker Metrics
// ============================================================================

/**
 * Total count of jobs processed by worker consumers.
 * Labels: type, status ('COMPLETED', 'FAILED', 'CANCELLED')
 */
export const workerJobsProcessedTotal = new Counter({
  name: 'forgeflow_worker_jobs_processed_total',
  help: 'Total number of jobs processed by worker consumers.',
  labelNames: ['type', 'status'],
  registers: [register],
});

/**
 * Total count of failed worker job executions.
 * Labels: type, error_category ('RETRYABLE', 'NON_RETRYABLE', 'UNKNOWN')
 */
export const workerJobsFailedTotal = new Counter({
  name: 'forgeflow_worker_jobs_failed_total',
  help: 'Total number of job execution failures in worker.',
  labelNames: ['type', 'error_category'],
  registers: [register],
});

/**
 * Execution duration of worker jobs in seconds.
 * Labels: type, status
 */
export const jobProcessingDurationSeconds = new Histogram({
  name: 'forgeflow_job_processing_duration_seconds',
  help: 'Duration of background job processing execution in seconds.',
  labelNames: ['type', 'status'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 2.5, 3, 5, 10, 30, 60],
  registers: [register],
});

/**
 * Total count of duplicate job deliveries skipped due to worker idempotency.
 * Labels: type, reason ('ALREADY_COMPLETED', 'ACTIVE_ON_ANOTHER_WORKER', 'JOB_CANCELLED', etc.)
 */
export const workerDuplicateJobsSkippedTotal = new Counter({
  name: 'forgeflow_worker_duplicate_jobs_skipped_total',
  help: 'Total number of duplicate job executions skipped due to worker idempotency.',
  labelNames: ['type', 'reason'],
  registers: [register],
});

/**
 * Total count of job retry attempts scheduled by worker.
 * Labels: type
 */
export const workerRetriesScheduledTotal = new Counter({
  name: 'forgeflow_worker_retries_scheduled_total',
  help: 'Total number of retry attempts scheduled to retry queue.',
  labelNames: ['type'],
  registers: [register],
});

/**
 * Total count of messages routed to Dead Letter Queue (DLQ).
 * Labels: type, reason ('NON_RETRYABLE', 'MAX_RETRIES_EXHAUSTED', 'POISON_UNPARSEABLE_MESSAGE')
 */
export const workerDlqMessagesTotal = new Counter({
  name: 'forgeflow_worker_dlq_messages_total',
  help: 'Total number of messages routed to the Dead Letter Queue.',
  labelNames: ['type', 'reason'],
  registers: [register],
});

// ============================================================================
// Utilities
// ============================================================================

/**
 * Resets all metric values in the default registry (useful for unit tests).
 */
export function resetMetrics(): void {
  register.resetMetrics();
}

/**
 * Normalizes HTTP route paths to prevent high-cardinality label explosion.
 * Replaces UUIDs and numeric IDs with ':id'.
 */
export function normalizeMetricRoute(rawPath: string, routePattern?: string): string {
  if (routePattern) {
    return routePattern;
  }
  if (!rawPath) return '/';

  // Strip query strings
  const pathWithoutQuery = rawPath.split('?')[0];

  // Replace standard UUID pattern (8-4-4-4-12 hex chars)
  const normalized = pathWithoutQuery
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
    // Replace numeric path segments e.g. /users/123 -> /users/:id
    .replace(/\/\d+(?=\/|$)/g, '/:id');

  return normalized || '/';
}
