-- Migration 004: Add retry state fields and constraints to jobs table (Phase 6.1)

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_retries INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS last_error TEXT NULL,
  ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ NULL;

-- Add check constraints to prevent negative values
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_jobs_retry_count') THEN
    ALTER TABLE jobs ADD CONSTRAINT chk_jobs_retry_count CHECK (retry_count >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_jobs_max_retries') THEN
    ALTER TABLE jobs ADD CONSTRAINT chk_jobs_max_retries CHECK (max_retries >= 0);
  END IF;
END $$;

-- Index for retry scheduling queries
CREATE INDEX IF NOT EXISTS idx_jobs_retry_scheduling ON jobs(status, next_retry_at) WHERE next_retry_at IS NOT NULL;
