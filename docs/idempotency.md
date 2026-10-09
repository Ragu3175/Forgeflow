# ForgeFlow End-to-End Idempotency (Phase 5)

ForgeFlow implements a **two-layer defense-in-depth idempotency model**:
1. **Layer 1: API-Level Idempotency** (Client ➔ API): Prevents duplicate HTTP requests from creating multiple logical jobs.
2. **Layer 2: Worker-Side Idempotency** (RabbitMQ ➔ Worker): Prevents redelivered or duplicate queue messages from causing duplicate execution.

---

## Comparison: API Idempotency vs. Worker-Side Idempotency

| Feature | Layer 1: API Idempotency | Layer 2: Worker-Side Idempotency |
| :--- | :--- | :--- |
| **Problem Solved** | Client double-click, network timeout retries on `POST /jobs` | RabbitMQ message redelivery, worker crash before ACK |
| **Identity Token** | Client-provided `Idempotency-Key` HTTP Header | System-generated `job_id` (UUID) |
| **Authority Table** | `idempotency_keys` | `job_executions` |
| **Uniqueness Constraint**| `UNIQUE (user_id, key)` | `UNIQUE (job_id)` |
| **Deduplication Action** | Skips DB insert & RabbitMQ publish; returns existing Job | Skips 2-3s workload; sends manual RabbitMQ ACK |
| **Target Resource** | 1 logical Job in PostgreSQL | 1 logical Execution of that Job |

---

## Layer 1: API Idempotency

### Execution Flow:
1. **Validation**: The API validates the `Idempotency-Key` header (rejects missing, empty, or keys exceeding 255 characters with HTTP 400).
2. **Fast Lookup**: Checks table `idempotency_keys` for `(user_id, key)`.
3. **Stored Replay**: If found, returns the original job with HTTP `200 OK` and `Idempotent-Replayed: true` header. No second job is created and no RabbitMQ message is published.
4. **Atomic Creation**: Inside a PostgreSQL transaction (`withTransaction`):
   - Inserts job with status `PENDING` into `jobs`.
   - Inserts `(user_id, key, job_id)` into `idempotency_keys`.
   - Commits transaction.
5. **Event Publishing**: Publishes message to RabbitMQ `forgeflow.jobs` and returns HTTP `201 Created`.
6. **Concurrency Conflict Handling**: If concurrent requests arrive simultaneously, the PostgreSQL unique constraint `uq_idempotency_keys_user_key` throws error `23505`. The losing transaction automatically rolls back and safely retrieves the winning committed job.

---

## Layer 2: Worker-Side Idempotency

### The Distributed Problem:
RabbitMQ uses manual acknowledgements (`ch.ack(msg)`). In production, a worker can successfully complete the heavy processing and update PostgreSQL, but crash or lose network connectivity right before sending the ACK to RabbitMQ. RabbitMQ will then redeliver the message to another worker node. Without worker-side idempotency, the heavy 2-3s task (or external email/PDF generation) would be executed multiple times.

### Schema: `job_executions`
```sql
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
```

### Worker State Machine:
```
Message Arrives (jobId)
  │
  ├─► Check job_executions for jobId
  │     │
  │     ├─► [Status = COMPLETED]
  │     │     └─► Log & Skip Workload ──► Invalidate Redis Cache ──► ACK Message
  │     │
  │     ├─► [Status = RUNNING]
  │     │     ├─► [Stale > 30s (Worker Crash)]: Atomically Recover Claim ──► Re-execute Workload
  │     │     └─► [Active < 30s]: Skip duplicate concurrent processing
  │     │
  │     └─► [No Record]
  │           └─► Atomically Claim: INSERT INTO job_executions ... ON CONFLICT (job_id) DO NOTHING
  │                 │
  │                 ├─► [Claim Won]:
  │                 │     1. Update jobs to RUNNING & Invalidate Redis Cache
  │                 │     2. Execute simulated workload (2.5s)
  │                 │     3. PostgreSQL Transaction: Mark job_executions & jobs as COMPLETED
  │                 │     4. Invalidate Redis Cache
  │                 │     5. ACK RabbitMQ Message
  │                 │
  │                 └─► [Claim Lost (Race)]:
  │                       Check winner status & skip duplicate workload ──► ACK Message
```

---

## 3. Crucial Distributed Systems Limitation

> [!WARNING]
> **Database idempotency cannot automatically make arbitrary external side-effects atomic.**

- A PostgreSQL transaction guarantees atomic updates across `jobs`, `idempotency_keys`, and `job_executions`.
- However, if the worker triggers **external, non-transactional side-effects** (such as calling third-party payment APIs, sending external emails via SMTP, or invoking external webhooks) before committing the database transaction, a worker crash mid-flight could still result in external side-effects occurring prior to the database rollback.
- Handling arbitrary external side-effects requires downstream idempotency keys on external APIs (e.g. Stripe Idempotency Keys), transactional outbox patterns, or two-phase commit / compensating saga workflows.
