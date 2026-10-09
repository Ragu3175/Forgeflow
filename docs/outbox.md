# ForgeFlow Transactional Outbox Pattern (Phase 7)

This document details ForgeFlow's **Transactional Outbox Pattern** implementation, eliminating the distributed dual-write consistency gap between PostgreSQL and RabbitMQ.

---

## 1. The Dual-Write Problem

In distributed architectures, an application often needs to update a database and publish an event to a message broker in response to a single client request.

### The Problematic Naive Flow:
```
Client ──(POST /jobs)──> [API]
                           │
                           ├── 1. BEGIN DB Transaction
                           │      INSERT INTO jobs ...
                           │      INSERT INTO idempotency_keys ...
                           │   2. COMMIT DB Transaction  <── (Succeeds)
                           │
                           ▼
                      (CRASH / Network Blip)
                           │
                           └── 3. publishToRabbitMQ()    <── (NEVER EXECUTES)
```

### Consequences of Naive Dual-Write:
- If the API crashes or loses network connectivity between Step 2 (Database Commit) and Step 3 (Broker Publish), the job row is stored in PostgreSQL as `PENDING`, but no message is ever sent to RabbitMQ.
- The job becomes permanently orphaned / stuck in `PENDING` state with no worker ever receiving it.
- Wrapping the RabbitMQ publish inside the database transaction is also an anti-pattern: if RabbitMQ takes time or hangs, database locks are held unnecessarily; and if the database transaction subsequently fails/rolls back on commit, a message was already sent to the broker for a job that does not exist.

---

## 2. The Transactional Outbox Pattern

The Transactional Outbox pattern guarantees **atomicity** between database state and message dispatch by persisting message intent directly inside the **same database transaction** as the business entity.

```
API
 │
 ├── 1. BEGIN PostgreSQL Transaction
 │      ├── INSERT INTO jobs (status: 'PENDING')
 │      ├── INSERT INTO idempotency_keys (key, user_id, job_id)
 │      └── INSERT INTO outbox_events (event_type: 'JOB_CREATED', payload: {...}, status: 'PENDING')
 │   2. COMMIT Transaction
 │
 ▼
Outbox Publisher (Background Process)
 │
 ├── 3. SELECT ... FOR UPDATE SKIP LOCKED
 │      Claim batch of PENDING outbox events
 ├── 4. Publish to RabbitMQ (queue: 'forgeflow.jobs')
 └── 5. UPDATE outbox_events SET status = 'PUBLISHED', published_at = NOW()
```

### Key Guarantees:
1. **Atomic Intent**: Either the job, idempotency key, and outbox event are all written together, or none are.
2. **Decoupled Transport**: RabbitMQ communication happens outside the database transaction boundary.
3. **Resilience**: Even if the API crashes immediately after client response, the Outbox Publisher will pick up and dispatch the pending outbox event upon recovery.

---

## 3. Database Schema: `outbox_events`

Created in migration `005_outbox_events.sql`:

```sql
CREATE TABLE IF NOT EXISTS outbox_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type VARCHAR(100) NOT NULL,
  aggregate_type VARCHAR(50) NOT NULL,
  aggregate_id UUID NOT NULL,
  payload JSONB NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ NULL,
  last_error TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Constraints
ALTER TABLE outbox_events ADD CONSTRAINT chk_outbox_attempts CHECK (attempts >= 0);
ALTER TABLE outbox_events ADD CONSTRAINT chk_outbox_status CHECK (status IN ('PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED'));

-- Performance Indexes
CREATE INDEX IF NOT EXISTS idx_outbox_polling ON outbox_events (status, available_at, created_at) WHERE status IN ('PENDING', 'FAILED');
CREATE INDEX IF NOT EXISTS idx_outbox_aggregate ON outbox_events (aggregate_type, aggregate_id);
```

---

## 4. Publisher Flow & Locking Strategy

### Atomic Claiming via `SELECT ... FOR UPDATE SKIP LOCKED`
To support horizontal scaling with multiple API nodes running concurrently without duplicate claiming or deadlocks, the Outbox Publisher queries pending rows with row-level locks:

```sql
SELECT *
FROM outbox_events
WHERE status IN ('PENDING', 'FAILED')
  AND available_at <= NOW()
ORDER BY created_at ASC
LIMIT $1
FOR UPDATE SKIP LOCKED;
```

### Why `SKIP LOCKED`?
- **Zero Lock Contention**: If Node A locks Events 1–10, Node B running concurrently skips those locked rows and immediately locks Events 11–20 without blocking or waiting.
- **Fair FIFO Ordering**: Events are processed in chronological order of creation (`ORDER BY created_at ASC`).

### Publishing Loop:
1. **Trigger on Commit**: When `jobService.createJob` commits a transaction, it asynchronously triggers `outboxPublisher.trigger()` for sub-millisecond message dispatch.
2. **Background Polling**: A periodic timer loop (default: 1000ms) continually polls for any pending or retryable failed events that may have been delayed or missed during restarts.
3. **Success**: On successful AMQP publish, the event is marked `status = 'PUBLISHED'` and `published_at = NOW()`.
4. **Retry on Failure**: If RabbitMQ is unreachable, the publisher catches the error, increments `attempts`, logs `last_error`, and calculates exponential backoff:
   $$\text{delayMs} = \min(1000 \times 2^{\text{attempts}}, 30000)$$
   setting `available_at = NOW() + delayMs` and `status = 'FAILED'`.

---

## 5. Failure Scenarios & Crash Recovery

| Scenario | Behavior | Outcome |
| :--- | :--- | :--- |
| **API crashes before DB Commit** | Transaction rolls back automatically. | Neither job, idempotency key, nor outbox event exists. No message sent. Client receives 500/timeout and retries safely. |
| **API crashes after DB Commit but before Publisher runs** | Job & outbox event are persisted in PostgreSQL. | On API restart / next polling cycle, the publisher claims the pending outbox event and dispatches it to RabbitMQ. |
| **RabbitMQ broker down** | Publisher fails to publish, records error, and applies exponential backoff on `available_at`. | As soon as RabbitMQ becomes available, the publisher retries and dispatches all accumulated outbox events. |
| **Publisher crashes AFTER RabbitMQ publish, BEFORE marking PUBLISHED** | The message was already delivered to RabbitMQ. The DB transaction was rolled back or dropped on crash. | The outbox event remains `PENDING`. Upon restart, the publisher claims and publishes the event again. **Worker Idempotency** detects that the job was already executed/completed and safely skips re-execution. |

---

## 6. At-Least-Once Delivery vs. Exactly-Once Delivery

> [!IMPORTANT]
> **ForgeFlow does NOT claim Exactly-Once Delivery.**
> In distributed systems with independent networks and storage nodes, true end-to-end "exactly-once delivery" across heterogeneous distributed systems is physically impossible without distributed locks/2PC (which reduce availability and scalability).

### The ForgeFlow Guarantee:
1. **PostgreSQL Transaction**: Guarantees **durable intent** (atomic write of entity + outbox event).
2. **Transactional Outbox Publisher**: Guarantees **at-least-once message publication** (messages will never be lost, but might be published more than once during crash recovery).
3. **Worker Idempotency (`job_executions`)**: Makes **duplicate delivery safe** (duplicate messages are detected and skipped in $<1\text{ms}$).

$$\text{At-Least-Once Delivery} + \text{Worker Idempotency} = \text{Effectively-Once Processing}$$

---

## 7. Verification & Testing Summary

Automated tests in `apps/api/test/outbox.test.ts`:
- **Test A**: Verified atomic commit of `jobs` + `idempotency_keys` + `outbox_events`.
- **Test B**: Verified rollback safety leaving zero orphaned jobs or outbox rows.
- **Test C**: Verified outbox claiming, RabbitMQ dispatch, and transition to `PUBLISHED`.
- **Test D**: Verified publisher failure backoff and retry scheduling.
- **Test E**: Verified multi-publisher concurrency via `SELECT ... FOR UPDATE SKIP LOCKED` with zero collision.
- **Test F (Failure Experiment)**: Simulated crash between AMQP publish and outbox status commit. Verified publisher re-claimed and re-published on restart, and Worker Idempotency ensured exactly 1 execution record with zero duplicate workloads.
- **E2E Docker Suite**: Verified live container integration across API, Outbox Publisher, PostgreSQL, Redis, RabbitMQ, and Worker.
