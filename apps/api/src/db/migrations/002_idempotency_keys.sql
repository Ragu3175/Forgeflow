-- Migration 002: Idempotency Keys table for API-level Idempotency (Phase 5)

CREATE TABLE IF NOT EXISTS idempotency_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key VARCHAR(255) NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_idempotency_keys_user_key UNIQUE (user_id, key)
);

-- Index on (user_id, key) for fast idempotency lookups
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_user_key ON idempotency_keys(user_id, key);

-- Index on job_id for foreign key lookups and cascading operations
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_job_id ON idempotency_keys(job_id);
