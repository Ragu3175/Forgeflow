# ForgeFlow Retries & Dead Letter Queue (Phase 6)

This document provides a comprehensive guide to ForgeFlow's distributed retry system, RabbitMQ topology, Dead Letter Queue (DLQ), error classification, and worker idempotency integration.

---

## 1. Why Retrying is Necessary in Distributed Systems

In production distributed systems, transient failures are inevitable:
- Intermittent network timeouts or TCP socket resets (`ECONNRESET`, `ETIMEDOUT`).
- Downstream microservices or rendering engines returning HTTP `503 Service Unavailable` or `504 Gateway Timeout`.
- Database lock contention or transient deadlocks.
- External API rate-limiting (`429 Too Many Requests`).

Without an automated, durable retry policy, any transient network blip permanently fails long-running user workloads.

---

## 2. Why `nack(requeue=true)` Alone is Insufficient & Dangerous

A naive retry implementation in AMQP relies on rejecting failed messages with `channel.nack(msg, false, true)`:

```
[Worker] ──(fail)──> nack(requeue=true) ──> [Queue Top] ──> [Worker] (instant retry!)
```

### The 3 Major Pitfalls:
1. **Tight CPU / I/O Loop**: If a failure is persistent (e.g. invalid JSON, missing database column, downed service), `nack(requeue=true)` puts the message right back at the front of the queue. The worker re-consumes it milliseconds later, executing thousands of iterations per second, flooding logs and maxing out CPU cores.
2. **Head-of-Line Blocking**: A single failing message at the head of a FIFO queue prevents all healthy messages queued behind it from being processed.
3. **Thundering Herd**: If hundreds of jobs fail simultaneously due to a momentary network drop, immediate requeuing causes an uncoordinated stampede of requests against downstream dependencies.

---

## 3. RabbitMQ Topology Architecture (Phase 6.2)

ForgeFlow utilizes standard, native RabbitMQ primitives (compatible across standard Alpine RabbitMQ without requiring third-party plugins) combining **Per-Message TTL** with **Dead-Letter Exchanges (DLX)**.

```
                                  ┌────────────────────────┐
                                  │      Client / API      │
                                  └───────────┬────────────┘
                                              │ (publish new job)
                                              ▼
                                 ┌───────────────────────────┐
                                 │    forgeflow.jobs         │◄─────────────────────────┐
                                 │     (Main Queue)          │                          │
                                 └────────────┬──────────────┘                          │
                                              │                                         │
                                              │ (consume message)                       │
                                              ▼                                         │
                                 ┌───────────────────────────┐                          │
                                 │     ForgeFlow Worker      │                          │
                                 └───────┬───────────┬───────┘                          │
                                         │           │                                  │
                  (retryable error,      │           │ (exhausted, non-retryable,       │ (TTL expires)
                   attempts < max)       │           │  or poison message)              │
                                         ▼           ▼                                  │
   ┌──────────────────────────────────────┐         ┌───────────────────────────────┐   │
   │      forgeflow.retry.exchange        │         │         forgeflow.dlx         │   │
   │          (Direct Exchange)           │         │       (Direct Exchange)       │   │
   └──────────────────┬───────────────────┘         └───────────────┬───────────────┘   │
                      │                                             │                   │
                      │ (routing key:                               │ (routing key:     │
                      │  forgeflow.jobs.retry)                      │  forgeflow.jobs.dlq)
                      ▼                                             ▼                   │
   ┌──────────────────────────────────────┐         ┌───────────────────────────────┐   │
   │        forgeflow.jobs.retry          │         │      forgeflow.jobs.dlq       │   │
   │            (Delay Queue)             │         │          (Dead Letter)        │   │
   │  arguments:                          │         └───────────────────────────────┘   │
   │   x-dead-letter-exchange: ''         │                                             │
   │   x-dead-letter-routing-key:         │                                             │
   │     'forgeflow.jobs'                 │                                             │
   └──────────────────┬───────────────────┘                                             │
                      │                                                                 │
                      └─────────────────────────────────────────────────────────────────┘
```

### Topology Components:

| Component | Type | Durable | Details & Configuration |
| :--- | :--- | :--- | :--- |
| **`forgeflow.jobs`** | Queue | Yes | Primary processing queue consumed by workers. |
| **`forgeflow.retry.exchange`** | Direct Exchange | Yes | Direct exchange routing retryable messages to the delay queue. |
| **`forgeflow.jobs.retry`** | Queue (Delay) | Yes | Holds messages for the backoff duration. Configured with:<br>`x-dead-letter-exchange: ''`<br>`x-dead-letter-routing-key: 'forgeflow.jobs'` |
| **`forgeflow.dlx`** | Direct Exchange | Yes | Direct exchange routing dead-lettered messages to the DLQ. |
| **`forgeflow.jobs.dlq`** | Queue (DLQ) | Yes | Dedicated Dead Letter Queue holding exhausted, non-retryable, or poison messages. |

---

## 4. Delayed Retry Routing Mechanism

When a worker encounters a retryable failure:
1. **Durable State Update**: The worker increments `retry_count` in PostgreSQL, calculates `next_retry_at`, updates `last_error`, and sets job status to `PENDING`.
2. **Backoff Calculation**: The worker calculates delay $D$ with exponential backoff and jitter.
3. **Publish with Per-Message TTL**: The worker publishes the job message to `forgeflow.retry.exchange` (`routingKey: forgeflow.jobs.retry`) with `expiration: String(delayMs)` and `persistent: true`.
4. **Safe Original ACK**: The worker calls `channel.ack(msg)` on the original message. This frees the main queue immediately and prevents head-of-line blocking.
5. **Automatic Re-Delivery**: When the message's per-message TTL expires in `forgeflow.jobs.retry`, RabbitMQ dead-letters the message using its configured default exchange and routing key `'forgeflow.jobs'`, placing it back onto the main queue for worker execution.

---

## 5. Dead Letter Queue (DLQ) Routing

Messages are routed to `forgeflow.dlx` ➔ `forgeflow.jobs.dlq` under three conditions:

1. **Non-Retryable Errors**: Errors where repeated execution will never succeed (e.g. malformed inputs, schema violations).
2. **Retries Exhausted**: When `retry_count >= max_retries` (default: 3 attempts).
3. **Poison Messages**: Corrupted buffers, invalid JSON, or crashes occurring before the message can be parsed.

### Diagnostic DLQ Message Headers:
Every message published to the DLQ contains rich diagnostic headers:
- `x-rejection-reason`: `'NON_RETRYABLE' | 'MAX_RETRIES_EXHAUSTED' | 'POISON_UNPARSEABLE_MESSAGE'`
- `x-error-message`: The detailed error message or stack summary.
- `x-retry-count`: Total number of retry attempts made before rejection.
- `x-original-queue`: The origin queue (`'forgeflow.jobs'`).
- `x-failed-at`: ISO-8601 timestamp of final rejection.

---

## 6. Error Classification

Errors are classified using explicit error classes and pattern matching:

```typescript
export class RetryableError extends Error {
  readonly isRetryable = true;
}

export class NonRetryableError extends Error {
  readonly isRetryable = false;
}
```

### Classification Rules:
- **`RETRYABLE`**:
  - Instances of `RetryableError`
  - System network codes: `ECONNRESET`, `ETIMEDOUT`, `ECONNREFUSED`, `EAI_AGAIN`
  - HTTP error codes: `408`, `429`, `500`, `502`, `503`, `504`
- **`NON_RETRYABLE`**:
  - Instances of `NonRetryableError`
  - Syntax errors, JSON parse errors (`SyntaxError`)
  - Validation failures, invalid schema parameters
  - HTTP client errors: `400`, `401`, `403`, `404`, `422`

---

## 7. Exponential Backoff & Jitter Formula

ForgeFlow uses **Full Jitter Exponential Backoff**:

$$\text{rawDelay} = \min(\text{baseDelay} \times 2^{\text{retryCount}}, \text{maxDelay})$$
$$\text{delayMs} = \text{Math.round}\left(\frac{\text{rawDelay}}{2} + \text{random}() \times \frac{\text{rawDelay}}{2}\right)$$

### Default Constants:
- **Base Delay**: `2000 ms` (2 seconds)
- **Max Delay**: `60000 ms` (60 seconds)
- **Default Max Retries**: `3`

### Delay Table:
| Attempt # | `retry_count` | Raw Backoff ($2^n \times 2\text{s}$) | Jittered Window ($[0.5 \times D, D]$) |
| :---: | :---: | :---: | :---: |
| **Attempt 1** | 0 | 2.0 s | **1.0 s – 2.0 s** |
| **Attempt 2** | 1 | 4.0 s | **2.0 s – 4.0 s** |
| **Attempt 3** | 2 | 8.0 s | **4.0 s – 8.0 s** |
| **Attempt 4** | 3 | 16.0 s | **8.0 s – 16.0 s** |
| **Exhausted** | $\ge 3$ | - | Routed to DLQ (`status = FAILED`) |

---

## 8. Coordination Between PostgreSQL and RabbitMQ

PostgreSQL is the **single authoritative source of truth** for all job state, while RabbitMQ is the **transport & timing coordinator**:

1. **Before Publishing / Retrying**: PostgreSQL is updated first with the durable state (`retry_count`, `last_error`, `next_retry_at`, `status`).
2. **Worker Idempotency via `job_executions`**:
   - `job_executions` enforces `UNIQUE(job_id)`.
   - When a job completes, `status = COMPLETED`. Duplicate message deliveries are recognized and skipped immediately.
   - When a job fails with a retryable error, `status = FAILED`.
   - On retry delivery, the worker executes:
     ```sql
     INSERT INTO job_executions (job_id, status, worker_id, started_at, updated_at)
     VALUES ($1, 'RUNNING', $2, NOW(), NOW())
     ON CONFLICT (job_id)
     DO UPDATE SET status = 'RUNNING', worker_id = $2, started_at = NOW(), updated_at = NOW(), error = NULL
     WHERE job_executions.status = 'FAILED'
     RETURNING *;
     ```
   - This guarantees that retries of failed jobs can proceed, while completed jobs can never be re-run.

---

## 9. Failure & Recovery Scenarios

| Scenario | System Behavior | Safety Guarantee |
| :--- | :--- | :--- |
| **Worker crashes during workload** | PostgreSQL execution remains `RUNNING` with old heartbeat. RabbitMQ channel closes and unacknowledged message is requeued. | Another worker detects stale execution ($>30\text{s}$) via `claimStaleExecution` and safely assumes ownership. |
| **Worker crashes after COMPLETED but before ACK** | RabbitMQ redelivers message to another worker. | Worker inspects `job_executions`, detects `COMPLETED`, skips workload in $<5\text{ms}$, and ACKs message. |
| **Concurrent duplicate message delivery** | Multiple workers receive duplicate messages simultaneously. | PostgreSQL atomic `ON CONFLICT` execution claim permits exactly 1 worker to execute; others receive `CONCURRENT_CLAIM_LOST` and safely ACK. |
| **Poison / corrupted message** | Worker JSON parse throws error in consumer loop. | Worker catches error, routes raw payload to `forgeflow.jobs.dlq` with `x-rejection-reason: POISON_UNPARSEABLE_MESSAGE`, and ACKs the main queue to prevent queue blocking. |
| **RabbitMQ broker restart** | RabbitMQ restarts; all queues (`forgeflow.jobs`, `forgeflow.jobs.retry`, `forgeflow.jobs.dlq`) and exchanges are declared `durable: true`, messages are `persistent: true`. | Message state is preserved on disk across broker restarts. |

---

## 10. Operational & Debugging Notes

### Inspecting Queues via Docker:
```bash
# Check queue depths and message counts
docker exec forgeflow-rabbitmq rabbitmqctl list_queues name messages messages_ready messages_unacknowledged

# View RabbitMQ exchanges
docker exec forgeflow-rabbitmq rabbitmqctl list_exchanges name type durable

# Inspect DLQ messages via AMQP or Management UI (http://localhost:15672, guest/guest)
```

### Inspecting Job Retry State in PostgreSQL:
```sql
SELECT id, status, retry_count, max_retries, last_error, next_retry_at, updated_at
FROM jobs
ORDER BY updated_at DESC
LIMIT 10;

SELECT job_id, status, worker_id, started_at, completed_at, error
FROM job_executions
ORDER BY updated_at DESC
LIMIT 10;
```
