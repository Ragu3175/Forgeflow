# ForgeFlow Local Load Balancing (Phase 8)

This document details ForgeFlow's **Local Load Balancing** architecture, stateless API design, horizontal scaling, health/readiness observability, and zero-downtime failover capabilities using Nginx and Docker Compose.

---

## 1. Why We Introduced Load Balancing

As distributed systems scale, running a single API instance creates critical vulnerabilities and bottlenecks:
1. **Single Point of Failure (SPOF)**: If the single API process crashes, runs out of memory, or undergoes a rolling restart, the entire platform becomes completely unavailable to clients.
2. **Throughput Bottlenecks**: A single Node.js event loop is limited by CPU core constraints and network I/O concurrency limits.
3. **Deployment Downtime**: Updating or restarting a single API container requires dropping in-flight traffic.

### The Solution:
Introducing a reverse proxy and load balancer (**Nginx**) in front of multiple identical, stateless API instances (**`api1`** and **`api2`**) enables **horizontal scaling**, **traffic distribution**, **failure isolation**, and **high availability**.

---

## 2. Target Architecture

```
                       Client / Web UI (:5173)
                                  │
                                  ▼
                     Nginx Reverse Proxy (:4000 / :8080)
                     [Upstream: Round-Robin + Failover]
                                  │
                   ┌──────────────┴──────────────┐
                   │                             │
                   ▼                             ▼
           ForgeFlow API #1              ForgeFlow API #2
          (INSTANCE_ID: api-1)          (INSTANCE_ID: api-2)
                   │                             │
                   └──────────────┬──────────────┘
                                  │
         ┌────────────────────────┼────────────────────────┐
         │                        │                        │
         ▼                        ▼                        ▼
   PostgreSQL (5432)         Redis (6379)           RabbitMQ (5672)
  [Source of Truth +     [Distributed Cache]       [Message Broker]
  Outbox + Idempotency]                                    │
                                                           ▼
                                                  ForgeFlow Worker Node
```

---

## 3. Stateless API Architecture

A fundamental prerequisite for horizontal scaling is that **the API layer must be genuinely stateless**. Any client request can land on any API instance without requiring session stickiness.

### Statelessness Rules Enforced in ForgeFlow:
1. **No In-Memory Sessions**: Authentication is handled via stateless **JSON Web Tokens (JWT)** signed by a shared secret (`JWT_SECRET`). Any API instance can independently verify and decode client tokens without consulting other instances.
2. **No Local Job State**: Job state is never stored in process memory. All job records and statuses (`PENDING`, `RUNNING`, `COMPLETED`, `FAILED`, `CANCELLED`) live in PostgreSQL.
3. **Shared Distributed Cache**: Caching uses a shared **Redis** instance. If `api-1` caches or invalidates a job, `api-2` immediately observes the updated cache state.
4. **Shared Idempotency Registry**: API idempotency keys are stored in the PostgreSQL `idempotency_keys` table. A repeated request sent to `api-2` with a key first registered on `api-1` correctly recognizes the replayed request and returns the existing job without duplicate creation.
5. **No Local Filesystem State**: No state required for application correctness is written to the container's local ephemeral filesystem.

---

## 4. Nginx Local Configuration & Upstream Routing

Nginx runs in an Alpine container (`forgeflow-nginx`) listening on port 80 and mapped to host ports `4000` and `8080`.

### `nginx/nginx.conf` Key Directives:

```nginx
upstream api_servers {
    # Round-robin load balancing across api1 and api2
    server api1:4000 max_fails=3 fail_timeout=10s;
    server api2:4000 max_fails=3 fail_timeout=10s;
}

server {
    listen 80;
    server_name localhost;

    # Nginx self-check endpoint
    location /nginx-health {
        access_log off;
        default_type text/plain;
        return 200 "healthy\n";
    }

    # Reverse proxy to load balanced upstream
    location / {
        proxy_pass http://api_servers;
        proxy_http_version 1.1;

        # Standard Proxy Headers
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";

        # Health-Aware Failover
        proxy_next_upstream error timeout invalid_header http_500 http_502 http_503 http_504;
        proxy_next_upstream_tries 2;

        # Timeouts
        proxy_connect_timeout 2s;
        proxy_send_timeout 30s;
        proxy_read_timeout 30s;

        # Load balancer identifier header
        add_header X-Load-Balancer "forgeflow-nginx" always;
    }
}
```

### Instance Identification:
To verify and demonstrate which API instance handled a request, each API process injects an `X-ForgeFlow-Instance` HTTP header:
- `X-ForgeFlow-Instance: api-1`
- `X-ForgeFlow-Instance: api-2`

---

## 5. Health vs. Readiness Endpoints

ForgeFlow distinguishes between **Liveness** (is the process alive?) and **Readiness** (can the process serve traffic?).

### Liveness Endpoint (`GET /health`):
- **Purpose**: Extremely lightweight ping to confirm the Node.js event loop and HTTP server are responsive.
- **Cost**: $O(1)$, zero database or network overhead.
- **Response**:
  ```json
  {
    "status": "ok",
    "service": "ForgeFlow API",
    "instance": "api-1",
    "version": "1.0.0",
    "timestamp": "2026-09-28T13:52:28.797Z"
  }
  ```

### Readiness Endpoint (`GET /ready`):
- **Purpose**: Probes vital downstream dependencies required to process API requests:
  1. PostgreSQL query (`SELECT 1`)
  2. Redis cache socket state (`isRedisReady()`)
  3. RabbitMQ channel state (`isRabbitMQReady()`)
- **Cost**: Lightweight, non-blocking check.
- **Status Codes**: Returns `HTTP 200` when all dependencies are connected; returns `HTTP 503 Service Unavailable` if any dependency is down.
- **Response (Ready)**:
  ```json
  {
    "status": "ready",
    "instance": "api-1",
    "timestamp": "2026-09-28T13:52:46.162Z",
    "dependencies": {
      "postgres": "ok",
      "redis": "ok",
      "rabbitmq": "ok"
    }
  }
  ```

---

## 6. Graceful Shutdown Mechanics

When a container orchestrator or Docker sends `SIGTERM` or `SIGINT` to stop an API instance:
1. **Stop Ingress**: The HTTP server stops accepting new connections (`server.close()`), allowing existing requests to finish processing.
2. **Stop Background Loops**: The Outbox Publisher polling timer is cleanly stopped (`outboxPublisher.stop()`).
3. **Close AMQP Channel & Connection**: RabbitMQ connections are cleanly closed (`closeRabbitMQ()`).
4. **Close Redis Client**: Redis socket connections are gracefully disconnected (`closeRedis()`).
5. **Drain Database Pool**: Active client connections in the PostgreSQL pool are drained and closed (`pool.end()`).
6. **Safety Timeout**: A 10-second unref timer guarantees the process will terminate even if an open handle hangs.

---

## 7. Multi-Instance Transactional Outbox Safety (`SKIP LOCKED`)

Both `api1` and `api2` run background Transactional Outbox Publishers concurrently.

### Why Concurrency Is Safe:
When claiming outbox events, ForgeFlow uses PostgreSQL row-level locks with `SKIP LOCKED`:

```sql
SELECT *
FROM outbox_events
WHERE status IN ('PENDING', 'FAILED')
  AND available_at <= NOW()
ORDER BY created_at ASC
LIMIT $1
FOR UPDATE SKIP LOCKED;
```

- If `api-1` claims events $1 \dots 10$, `api-2` executing simultaneously does **not wait or block**; instead, it automatically skips the locked rows and claims events $11 \dots 20$.
- Zero race conditions, zero deadlocks, and zero duplicate publishes.

---

## 8. Failure Isolation & Recovery Experiment Results

During test execution (`test/load-balancer.test.ts`):
1. Both `api-1` and `api-2` were receiving $50\%$ of traffic in round-robin distribution.
2. `forgeflow-api1` was stopped (`docker compose stop api1`).
3. 10 consecutive requests were sent through Nginx:
   - **Result**: $100\%$ of requests were seamlessly routed to `api-2` with `HTTP 200` and zero failed requests.
4. `forgeflow-api1` was started (`docker compose start api1`).
5. Once `api1` passed its health check, Nginx automatically restored it to the upstream pool, resuming balanced round-robin traffic distribution.

---

## 9. Monorepo Verification Summary

- **TypeScript Typecheck**: Passed across all 4 workspaces (`@forgeflow/shared`, `@forgeflow/api`, `@forgeflow/web`, `@forgeflow/worker`).
- **Production Build**: Built all shared libraries, API bundles, Worker scripts, and Vite web bundles.
- **Unit & Integration Test Suite**:
  - API Idempotency (`test/idempotency.test.ts`): PASSED
  - Transactional Outbox (`test/outbox.test.ts`): PASSED
  - Load Balancer & Failover (`test/load-balancer.test.ts`): PASSED
  - Worker Idempotency (`test/worker-idempotency.test.ts`): PASSED
  - RabbitMQ Retry & DLQ (`test/retry-dlq.test.ts`): PASSED
- **Docker Compose Stack**:
  - 8 services active and healthy (`forgeflow-nginx`, `forgeflow-api1`, `forgeflow-api2`, `forgeflow-worker`, `forgeflow-postgres`, `forgeflow-redis`, `forgeflow-rabbitmq`, `forgeflow-web`).

---

## 10. Limitations & Future Phases

- **Local Scope**: This phase utilizes Nginx inside Docker Compose on a single host. In cloud environments (e.g., AWS), managed load balancers (Application Load Balancer / Network Load Balancer) or Kubernetes Ingress controllers will replace the standalone Nginx container.
- **Round-Robin vs. Least Connections**: For CPU-intensive long-polling requests, `least_conn` or latency-based balancing algorithms can be configured in subsequent production hardening phases.
