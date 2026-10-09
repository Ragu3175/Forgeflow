-- Migration 003: Job Executions table for Worker-Side Idempotency (Phase 5 Part 2)

CREATE TABLE IF NOT EXISTS job_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  status VARCHAR(50) NOT NULL DEFAULT 'RUNNING',
  worker_id VARCHAR(255) NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ NULL,
  error TEXT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_job_executions_job_id UNIQUE (job_id)
);

-- Index on job_id for rapid lookups and foreign key constraints
CREATE INDEX IF NOT EXISTS idx_job_executions_job_id ON job_executions(job_id);

-- Index on status for monitoring and recovery of stale executions
CREATE INDEX IF NOT EXISTS idx_job_executions_status ON job_executions(status);
