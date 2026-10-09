// ============================================================================
// ForgeFlow Universal & Browser-Safe Shared Definitions
// ============================================================================

// Enums
export type JobStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export const JOB_STATUSES: readonly JobStatus[] = [
  'PENDING',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;

export type JobType =
  | 'PDF_GENERATION'
  | 'DATA_PROCESSING'
  | 'AI_SUMMARY'
  | 'EMAIL'
  | 'CUSTOM';

export const JOB_TYPES: readonly JobType[] = [
  'PDF_GENERATION',
  'DATA_PROCESSING',
  'AI_SUMMARY',
  'EMAIL',
  'CUSTOM',
] as const;

// Entity Models
export interface User {
  id: string;
  email: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface Job {
  id: string;
  userId: string;
  type: JobType;
  payload: Record<string, any>;
  status: JobStatus;
  retryCount: number;
  maxRetries: number;
  lastError: string | null;
  nextRetryAt: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
}

// Authentication DTOs
export interface RegisterDto {
  email: string;
  password: string;
  name: string;
}

export interface LoginDto {
  email: string;
  password: string;
}

export interface AuthResponse {
  token: string;
  user: User;
}

// Job DTOs
export interface CreateJobDto {
  type: JobType;
  payload?: Record<string, any>;
}

export interface JobStatsSummary {
  total: number;
  pending: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
}

export interface JobsListQuery {
  status?: JobStatus;
  type?: JobType;
  limit?: number;
  offset?: number;
}

export interface JobsListResponse {
  jobs: Job[];
  total: number;
  stats: JobStatsSummary;
}

export interface ApiErrorResponse {
  error: string;
  details?: unknown;
}

// Queue / Message Types (Phase 4 & Phase 6.2 Topology)
export const FORGEFLOW_JOBS_QUEUE = 'forgeflow.jobs';

// Retry Delay Topology (Phase 6.2)
export const FORGEFLOW_RETRY_EXCHANGE = 'forgeflow.retry.exchange';
export const FORGEFLOW_RETRY_QUEUE = 'forgeflow.jobs.retry';
export const FORGEFLOW_RETRY_ROUTING_KEY = 'forgeflow.jobs.retry';

// Dead Letter Queue (DLQ) Topology (Phase 6.2)
export const FORGEFLOW_DLX_EXCHANGE = 'forgeflow.dlx';
export const FORGEFLOW_DLQ_QUEUE = 'forgeflow.jobs.dlq';
export const FORGEFLOW_DLQ_ROUTING_KEY = 'forgeflow.jobs.dlq';

export interface JobQueueMessage {
  jobId: string;
  type: JobType;
  timestamp: string;
  requestId?: string;
  traceparent?: string;
  tracestate?: string;
}

// Idempotency Types (Phase 5)
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

export interface IdempotencyRecord {
  id: string;
  key: string;
  userId: string;
  jobId: string;
  createdAt: string;
}

// Transactional Outbox Types (Phase 7)
export type OutboxEventStatus = 'PENDING' | 'PROCESSING' | 'PUBLISHED' | 'FAILED';
export type OutboxEventType = 'JOB_CREATED' | 'JOB_CANCELLED';

export interface OutboxEvent {
  id: string;
  eventType: OutboxEventType;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, any>;
  status: OutboxEventStatus;
  attempts: number;
  availableAt: string;
  publishedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

// Retry Policy & Error Types (Phase 6.1)
export * from './retry';

// Type-only exports for observability (safe for browser)
export type * from './logger';
export type * from './metrics';
export type * from './tracing';
