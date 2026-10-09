# ForgeFlow Observability: Structured Logging & Correlation IDs (Phase 9.1)

## 1. Overview & Architecture

In a distributed job processing platform like ForgeFlow, a single user action crosses multiple process, network, and asynchronous boundaries:

```
Client Request (X-Request-ID: req_123)
      │
      ▼
Nginx Load Balancer (Reverse Proxy)
      │
      ▼
API Instance 1 or 2 (`api-1` / `api-2`)
 ├── Correlation Middleware (extracts/generates requestId)
 ├── Request Log: request_started (requestId, instanceId)
 └── Atomic PostgreSQL Transaction
      ├── jobs table (jobId)
      ├── idempotency_keys table
      └── outbox_events table (payload carries requestId + jobId)
 ├── Outbox Event Created Log (eventId, jobId, requestId)
 ├── Job Created Log (jobId, requestId, instanceId)
 └── Response Log: request_completed (durationMs, statusCode)
      │
      ▼
Transactional Outbox Publisher
 ├── Claims outbox event
 ├── Publishes to RabbitMQ (`forgeflow.jobs` queue with requestId header + payload)
 └── Outbox Event Published Log (eventId, jobId, requestId)
      │
      ▼
RabbitMQ Broker (`forgeflow.jobs` durable queue)
      │
      ▼
Worker Process (`worker-local-dev`)
 ├── Queue Consumer receives message (extracts requestId + jobId)
 ├── Lifecycle Log: job_received (workerId, jobId, requestId)
 ├── Lifecycle Log: job_execution_started (workerId, jobId, requestId)
 ├── Processing Execution (with database updates & cache invalidation)
 ├── Lifecycle Log: job_execution_completed (workerId, jobId, requestId, durationMs)
 └── Message ACK
```

Before Phase 9.1, each service emitted ad-hoc string logs (`console.log`) without consistent structure, and requests lost their identity the moment they entered the database outbox or RabbitMQ queue.

Phase 9.1 introduces:
1. **Universal Structured JSON Logging** with standard field schema.
2. **Correlation ID Propagation (`requestId`)** across HTTP, Database Outbox, RabbitMQ, and Worker execution contexts.
3. **Multi-Instance and Worker Identity (`instanceId`, `workerId`)**.
4. **Automated Credential and Sensitive Payload Redaction**.

---

## 2. Structured JSON Logging

### Why JSON Logs?
Unstructured string logs (e.g., `console.log("Job " + id + " completed in " + ms)`) require brittle regular expressions to parse, making automated querying, aggregation, filtering, and alert indexing inefficient and error-prone.

Structured JSON logs ensure every log line is a valid, single-line JSON object that can be ingested and parsed deterministically by log forwarders (such as Vector, Fluentbit, CloudWatch, or Logstash).

### Standard Log Schema

Every log emitted in ForgeFlow conforms to the [`StructuredLogEntry`](file:///e:/Raguram/ragu/forgeflow/packages/shared/src/logger.ts) interface:

| Field | Type | Description |
| :--- | :--- | :--- |
| `timestamp` | `string` (ISO 8601) | Precise timestamp in UTC (e.g., `"2026-09-29T10:51:48.479Z"`). |
| `level` | `string` | Log severity level: `"debug"`, `"info"`, `"warn"`, or `"error"`. |
| `service` | `string` | Service emitting the log (`"forgeflow-api"`, `"forgeflow-worker"`). |
| `event` | `string` | Machine-readable lifecycle or operation event name (e.g., `"job_created"`). |
| `requestId` | `string` (optional) | Correlation ID tracing the end-to-end user request lifecycle. |
| `jobId` | `string` (optional) | Unique identifier of the job being created, polled, or processed. |
| `instanceId` | `string` (optional) | API instance identifier (e.g., `"api-1"`, `"api-2"`). |
| `workerId` | `string` (optional) | Worker node identifier (e.g., `"worker-local-dev"`). |
| `durationMs` | `number` (optional) | Execution or operation latency in milliseconds. |
| `statusCode` | `number` (optional) | HTTP response status code for API request logs. |
| `error` | `object` (optional) | Structured error details (`name`, `message`, `stack`, `code`). |
| `...metadata` | `object` (optional) | Contextual metadata (e.g., `userId`, `type`, `attempt`). |

---

## 3. Correlation Identifiers

### A. Request ID (`requestId`)
- **Purpose**: Correlates all operations initiated by a specific external request.
- **Extraction & Ingestion**:
  - The API correlation middleware checks the incoming `X-Request-ID` header.
  - If supplied by the client/upstream gateway, it preserves and sanitizes it.
  - If omitted, it generates a standard UUID v4.
- **Context Injection**:
  - Attached to Express `req.requestId`.
  - Injected as `req.logger = apiLogger.child({ requestId })`.
  - Returned in the HTTP response header `X-Request-ID`.
- **Security Rule**: `requestId` is strictly correlation metadata; it is **never** trusted as an authentication token, session identifier, or security credential.

### B. Job ID (`jobId`)
- **Purpose**: Identifies the domain aggregate (the background job) created in PostgreSQL.
- A single `jobId` may experience multiple retries, stale-worker crash recoveries, and DLQ routings over its lifecycle.
- While `requestId` links the initial job creation request, `jobId` links subsequent status queries, worker retries, and dead-letter investigations.

### C. Instance ID (`instanceId`)
- **Purpose**: Identifies the specific API node that handled an HTTP request or published an outbox event.
- In load-balanced multi-instance deployments (`api-1`, `api-2`), `instanceId` isolates node-specific anomalies (e.g., memory exhaustion or degraded database pool on `api-1` while `api-2` remains healthy).

### D. Worker ID (`workerId`)
- **Purpose**: Identifies the worker consumer node executing a background job.
- Used in worker idempotency claims (`job_executions.worker_id`) and crash recovery detection (`job_stale_recovery`).

---

## 4. Why Correlation IDs Must Cross Asynchronous Boundaries

In traditional synchronous web applications, a request begins and ends within a single thread or process call stack. Context propagation can rely on thread-local storage or request-scoped dependency injection.

However, ForgeFlow uses an asynchronous, distributed event-driven architecture:

```
[API Process] ──> [PostgreSQL Outbox] ──> [Outbox Poller] ──> [RabbitMQ Queue] ──> [Worker Process]
```

### The Broken Context Problem
If correlation IDs are only maintained in HTTP middleware:
1. The API commits the job and ends the HTTP request.
2. The Outbox Poller reads the database outbox independently minutes or seconds later.
3. RabbitMQ delivers a message to a Worker process on a separate machine.
4. **Result without propagation**: Worker logs appear with no link to the HTTP request that created the job, preventing developers from tracing user issues end-to-end.

### ForgeFlow's Cross-Boundary Propagation Solution
1. **Database Outbox Boundary**:
   - `jobService.createJob` writes the `requestId` into the JSONB payload of `outbox_events`:
     ```json
     {
       "jobId": "08716352-27bd-44c9-a6eb-362e83fd39b0",
       "type": "PDF_GENERATION",
       "requestId": "demo-trace-1790679108288"
     }
     ```
2. **RabbitMQ Broker Boundary**:
   - `OutboxPublisher` extracts `payload.requestId` and sends it as part of `JobQueueMessage` and AMQP headers:
     ```ts
     const message: JobQueueMessage = {
       jobId: event.payload.jobId,
       type: event.payload.type,
       requestId: event.payload.requestId,
       timestamp: event.created_at.toISOString()
     };
     ```
3. **Worker Consumer Boundary**:
   - `workerConsumer` parses `JobQueueMessage.requestId` and creates a child logger:
     ```ts
     const jobLogger = workerLogger.child({
       jobId: message.jobId,
       requestId: message.requestId
     });
     ```
4. **Retry & DLQ Boundaries**:
   - When a job fails and is scheduled for retry or routed to the DLQ (`forgeflow.jobs.retry` / `forgeflow.jobs.dlq`), the `requestId` header and message payload are preserved intact.

---

## 5. Security & Sensitive Data Redaction

Logging sensitive credentials compromises system security and violates compliance standards (GDPR, PCI-DSS, SOC 2).

ForgeFlow's structured logger automatically sanitizes all log payloads recursively before outputting JSON:

### Redacted Fields & Patterns
- **Direct Keys Redacted**: `password`, `password_hash`, `token`, `jwt`, `secret`, `authorization`, `cookie`, `apiKey`, `credentials`, `dbSecret`, `rabbitmq_password`, `client_secret`.
- **Value Pattern Masking**:
  - JWT Tokens (`eyJ...`) -> `"[REDACTED_JWT]"`
  - Authorization Header (`Bearer ...`) -> `"[REDACTED_BEARER_TOKEN]"`

```ts
// Example Input
logger.info('user_registered', {
  userId: '123',
  password: 'UserPlainTextPassword!',
  token: 'eyJhbGciOiJIUzI1Ni...'
});

// Emitted JSON Output
{
  "timestamp": "2026-09-29T10:51:48.509Z",
  "level": "info",
  "service": "forgeflow-api",
  "event": "user_registered",
  "userId": "123",
  "password": "[REDACTED]",
  "token": "[REDACTED]"
}
```

---

## 6. End-to-End Trace Walkthrough

Below is an actual verified lifecycle trace of a single job (`08716352-27bd-44c9-a6eb-362e83fd39b0`) with `requestId` = `demo-trace-1790679108288` traversing through the system:

```json
// 1. API receives HTTP POST /jobs through Nginx
{"timestamp":"2026-09-29T10:51:48.479Z","level":"info","service":"forgeflow-api","event":"request_started","instanceId":"api-1","requestId":"demo-trace-1790679108288","method":"POST","path":"/jobs","ip":"::ffff:172.18.0.8"}

// 2. API atomically inserts outbox event in PostgreSQL transaction
{"timestamp":"2026-09-29T10:51:48.503Z","level":"info","service":"forgeflow-api","event":"outbox_event_created","instanceId":"api-1","requestId":"demo-trace-1790679108288","jobId":"08716352-27bd-44c9-a6eb-362e83fd39b0","eventId":"5d2e5408-c0a0-4d53-8020-06ac1c008818","eventType":"JOB_CREATED"}

// 3. API commits job creation (PENDING)
{"timestamp":"2026-09-29T10:51:48.509Z","level":"info","service":"forgeflow-api","event":"job_created","instanceId":"api-1","requestId":"demo-trace-1790679108288","jobId":"08716352-27bd-44c9-a6eb-362e83fd39b0","userId":"377dc403-fdfe-475e-a372-751c319ab970","type":"PDF_GENERATION","status":"PENDING"}

// 4. API returns HTTP 201 response with X-Request-ID
{"timestamp":"2026-09-29T10:51:48.510Z","level":"info","service":"forgeflow-api","event":"request_completed","instanceId":"api-1","requestId":"demo-trace-1790679108288","durationMs":31,"method":"POST","path":"/jobs","statusCode":201}

// 5. Outbox publisher publishes message to RabbitMQ 'forgeflow.jobs'
{"timestamp":"2026-09-29T10:51:48.514Z","level":"info","service":"forgeflow-api","event":"outbox_event_published","instanceId":"api-1","requestId":"demo-trace-1790679108288","jobId":"08716352-27bd-44c9-a6eb-362e83fd39b0","durationMs":3,"eventId":"5d2e5408-c0a0-4d53-8020-06ac1c008818","eventType":"JOB_CREATED"}

// 6. Worker consumer receives message from queue
{"timestamp":"2026-09-29T10:51:48.516Z","level":"info","service":"forgeflow-worker","event":"job_received","workerId":"worker-local-dev","requestId":"demo-trace-1790679108288","jobId":"08716352-27bd-44c9-a6eb-362e83fd39b0","type":"PDF_GENERATION"}

// 7. Worker claims execution and updates status to RUNNING
{"timestamp":"2026-09-29T10:51:48.550Z","level":"info","service":"forgeflow-worker","event":"job_execution_started","workerId":"worker-local-dev","requestId":"demo-trace-1790679108288","jobId":"08716352-27bd-44c9-a6eb-362e83fd39b0","type":"PDF_GENERATION"}

// 8. Worker completes processing and updates status to COMPLETED
{"timestamp":"2026-09-29T10:51:51.067Z","level":"info","service":"forgeflow-worker","event":"job_execution_completed","workerId":"worker-local-dev","requestId":"demo-trace-1790679108288","jobId":"08716352-27bd-44c9-a6eb-362e83fd39b0","durationMs":2517}
```

---

## 7. Limitations of Structured Logging Alone

While structured logging and correlation IDs provide essential observability, logging alone has inherent limitations in large-scale distributed systems:

1. **No Real-Time Aggregated Metrics**:
   - Logs describe individual events, but cannot answer high-level questions in constant time (e.g., *"What is the p99 latency of job executions over the last 5 minutes?"* or *"What is the current queue backlog rate?"*).
   - Computing metrics by scanning terabytes of log entries is slow and costly.

2. **No Visual Distributed Tracing / Span Timelines**:
   - Correlation IDs link log entries together, but they do not capture parent-child span relationships or causal dependency graphs across services.
   - Diagnosing network delays between API commit and Outbox pickup requires manual log timestamp comparison rather than a single waterfall trace view.

3. **Storage & I/O Overhead at High Volume**:
   - High-throughput logging generates heavy disk I/O and storage costs. Sampling strategies and metric aggregation become necessary at scale.

4. **Alerting Latency**:
   - Alerting based on log parsing pipelines typically suffers from indexing delay (often 30s to several minutes) compared to lightweight metric-based time-series alerting (e.g., Prometheus / Grafana alerts).

---

# ForgeFlow Observability: Prometheus Metrics (Phase 9.2)

## 8. Logs vs. Metrics

Observability in distributed systems requires complementary telemetry types. Logs and metrics solve fundamentally different problems:

| Dimension | Structured Logs (Phase 9.1) | Prometheus Metrics (Phase 9.2) |
| :--- | :--- | :--- |
| **Data Nature** | Discrete, high-cardinality event records with rich contextual metadata. | Aggregated numeric time series sampled over regular time intervals. |
| **Granularity** | Individual request/job execution detail (per-event). | Statistical summary across all requests/jobs (rates, averages, percentiles). |
| **Storage & Cost** | Grows linearly with event volume ($O(N)$ events). High disk/network overhead. | Constant over time per metric series ($O(1)$ series count), independent of traffic volume. |
| **Query Speed** | Slow for historical aggregation across millions of events. | Sub-second evaluation of rates, percentiles, and alerts. |
| **Primary Use Cases** | Root-cause debugging, auditing, tracing specific `requestId` / `jobId`. | Real-time monitoring, alerting, capacity planning, SLA tracking. |

**The Golden Rule:** *Use metrics to know THAT something is wrong; use logs to know WHY it went wrong.*

---

## 9. Prometheus Metric Types in ForgeFlow

ForgeFlow utilizes three core Prometheus metric types from [`@forgeflow/shared`](file:///e:/Raguram/ragu/forgeflow/packages/shared/src/metrics.ts):

### A. Counter
- **Definition**: A cumulative metric that represents a single monotonically increasing counter whose value can only increase or be reset to zero on process restart.
- **Usage**: Used for measuring counts of events (requests received, jobs processed, errors encountered).
- **PromQL Examples**:
  - Request rate per second over 5m: `rate(forgeflow_http_requests_total[5m])`
  - Total worker failures in the last hour: `increase(forgeflow_worker_jobs_failed_total[1h])`

### B. Gauge
- **Definition**: A metric that represents a single numerical value that can arbitrarily go up and down.
- **Usage**: Used for measured current values like queue depths, active connections, CPU/memory usage, or cache sizes.
- **ForgeFlow Example**: `forgeflow_queue_depth{queue="forgeflow.jobs"}` queries AMQP broker state dynamically during each scrape.

### C. Histogram
- **Definition**: Samples observations (usually request durations or processing times) and counts them in configurable bucket ranges. It also provides a sum of all observed values and an event count.
- **Usage**: Used for measuring latency distributions and calculating arbitrary percentiles ($p50$, $p90$, $p95$, $p99$).
- **ForgeFlow Default Buckets**:
  - HTTP Requests: `[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]` seconds
  - Job Processing: `[0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300]` seconds
- **PromQL Example**:
  - 95th percentile HTTP latency: `histogram_quantile(0.95, sum(rate(forgeflow_http_request_duration_seconds_bucket[5m])) by (le, route))`

---

## 10. Scraping Architecture & Endpoints

Prometheus uses a **pull-based architecture**, periodically querying HTTP endpoints exposed by target services.

```
                  ┌───────────────────────────────┐
                  │      Prometheus Server        │
                  │        (Port 9090)            │
                  └───────────────┬───────────────┘
                                  │
          ┌───────────────────────┼───────────────────────┐
          │ Scrape (5s)           │ Scrape (5s)           │ Scrape (5s)
          ▼                       ▼                       ▼
┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│  API Instance 1  │    │  API Instance 2  │    │  Worker Service  │
│    `api1:4000`   │    │    `api2:4000`   │    │  `worker:9102`   │
│   GET /metrics   │    │   GET /metrics   │    │   GET /metrics   │
└──────────────────┘    └──────────────────┘    └──────────────────┘
```

### Endpoints
1. **API Instances (`api1:4000`, `api2:4000`)**:
   - `GET /metrics` exposes HTTP traffic metrics, job creation counters, and live RabbitMQ queue depth.
   - Handled via Express router in [`apps/api/src/routes/index.ts`](file:///e:/Raguram/ragu/forgeflow/apps/api/src/routes/index.ts).
2. **Worker Service (`worker:9102`)**:
   - Background workers do not serve public HTTP API routes.
   - ForgeFlow starts a dedicated, lightweight metrics HTTP server on port 9102 ([`apps/worker/src/metrics/index.ts`](file:///e:/Raguram/ragu/forgeflow/apps/worker/src/metrics/index.ts)) specifically for Prometheus scraping.

---

## 11. Metric Cardinality: Why Low Cardinality is Critical

### What is Cardinality?
Cardinality refers to the number of unique combinations of label values for a given metric. Each unique label set creates an independent time series in Prometheus:

$$\text{Total Series} = \prod_{i=1}^{N} |L_i|$$

### The Danger of High-Cardinality Labels
If a high-cardinality identifier (such as a UUID v4) is added as a label:
1. **Memory Explosion**: If 1,000,000 jobs are created, `forgeflow_jobs_created_total{job_id="..."}` creates 1,000,000 individual time series in Prometheus RAM.
2. **Scrape Timeout**: The `/metrics` endpoint text payload balloons from 5 KB to hundreds of megabytes.
3. **Database Thrashing**: Prometheus Head chunk indexing slows down dramatically and eventually triggers Out-Of-Memory (OOM) crashes.

### Strict Label Cardinality Rules in ForgeFlow
- **NEVER use dynamic IDs as labels**:
  - ❌ `jobId` / `job_id`
  - ❌ `requestId` / `request_id`
  - ❌ `userId` / `user_id`
  - ❌ `email`
  - ❌ `jwt` / `token`
  - ❌ Raw user input payloads
- **Route Normalization**:
  - Express routes with dynamic parameters (e.g. `GET /jobs/1e828d02-274d-422a-b7f0-c1f49f5568d2`) are sanitized using [`normalizeMetricRoute`](file:///e:/Raguram/ragu/forgeflow/packages/shared/src/metrics.ts) to `GET /jobs/:id` before recording metric observations.

---

## 12. Complete ForgeFlow Metrics Reference

| Metric Name | Type | Labels | Description |
| :--- | :--- | :--- | :--- |
| `forgeflow_http_requests_total` | Counter | `method`, `route`, `status_code` | Total count of HTTP requests processed by API instances. |
| `forgeflow_http_request_duration_seconds` | Histogram | `method`, `route`, `status_code` | Duration of HTTP requests in seconds. |
| `forgeflow_jobs_created_total` | Counter | `type`, `status` | Total count of background jobs created via API. |
| `forgeflow_jobs_completed_total` | Counter | `type` | Total count of jobs observed completed on the API side. |
| `forgeflow_jobs_failed_total` | Counter | `type` | Total count of jobs observed failed on the API side. |
| `forgeflow_worker_jobs_processed_total` | Counter | `type`, `status` | Total count of jobs processed by worker instances. |
| `forgeflow_worker_jobs_failed_total` | Counter | `type`, `error_type`, `retryable` | Total count of job processing failures in workers. |
| `forgeflow_job_processing_duration_seconds` | Histogram | `type`, `status` | Duration of background job execution in workers in seconds. |
| `forgeflow_worker_duplicate_jobs_skipped_total` | Counter | `type` | Total count of duplicate job deliveries skipped via worker idempotency. |
| `forgeflow_worker_retries_scheduled_total` | Counter | `type`, `attempt` | Total count of failed jobs routed to delayed retry queue. |
| `forgeflow_worker_dlq_messages_total` | Counter | `type`, `reason` | Total count of unrecoverable messages routed to Dead Letter Queue (DLQ). |
| `forgeflow_queue_depth` | Gauge | `queue` | Current depth (message count) of RabbitMQ queues. |

---

## 13. Docker & Prometheus Configuration

Prometheus is configured in [`prometheus/prometheus.yml`](file:///e:/Raguram/ragu/forgeflow/prometheus/prometheus.yml) and orchestrated via [`docker-compose.yml`](file:///e:/Raguram/ragu/forgeflow/docker-compose.yml):

```yaml
# prometheus/prometheus.yml
global:
  scrape_interval: 5s
  evaluation_interval: 5s

scrape_configs:
  - job_name: 'forgeflow-api'
    metrics_path: '/metrics'
    static_configs:
      - targets: ['api1:4000', 'api2:4000']
        labels:
          app: 'forgeflow-api'

  - job_name: 'forgeflow-worker'
    metrics_path: '/metrics'
    static_configs:
      - targets: ['worker:9102']
        labels:
          app: 'forgeflow-worker'
```

To verify Prometheus targets in local development:
- Open `http://localhost:9090/targets` or query `http://localhost:9090/api/v1/targets` to verify all 3 endpoints report state `UP`.

---

# ForgeFlow Observability: Grafana Metrics Visualization (Phase 9.3)

## 14. Prometheus vs. Grafana: Storage vs. Visualization

In a modern observability pipeline, **Prometheus** and **Grafana** perform distinct, complementary functions:

```
┌──────────────────────────────────────────────────────────┐
│                    Grafana (Port 3000)                   │
│   • Dashboard Visualization    • Interactive Filtering   │
│   • Multi-Panel Layouts        • Threshold Colorization  │
└────────────────────────────┬─────────────────────────────┘
                             │
                  PromQL Queries (via Proxy)
                             │
                             ▼
┌──────────────────────────────────────────────────────────┐
│                  Prometheus (Port 9090)                  │
│   • Time-Series Database (TSDB) • Scrape Engine (Pull)   │
│   • PromQL Evaluation           • In-Memory Head Chunks  │
└────────────────────────────┬─────────────────────────────┘
                             │
               HTTP Scrapes (GET /metrics, 5s)
                             │
          ┌──────────────────┼──────────────────┐
          ▼                  ▼                  ▼
┌──────────────────┐┌──────────────────┐┌──────────────────┐
│  API Instance 1  ││  API Instance 2  ││  Worker Service  │
│   `api1:4000`    ││   `api2:4000`    ││   `worker:9102`  │
└──────────────────┘└──────────────────┘└──────────────────┘
```

| Responsibility | Prometheus (Phase 9.2) | Grafana (Phase 9.3) |
| :--- | :--- | :--- |
| **Primary Role** | Metrics collector, storage engine (TSDB), PromQL query evaluator. | Visualization layer, interactive dashboard UI, user presentation. |
| **Data Storage** | Stores compressed time-series chunks on disk / in memory. | Stores dashboard definitions, users, and preferences (does **not** store metrics). |
| **Query Engine** | Executes PromQL mathematical aggregations (`rate`, `histogram_quantile`). | Issues PromQL queries over HTTP API to Prometheus and renders charts. |
| **Access Model** | Scrapes `/metrics` endpoints every 5 seconds. | Queries Prometheus on demand when users open or refresh dashboards. |

---

## 15. Grafana Datasource Auto-Provisioning

ForgeFlow uses **declarative provisioning** so Grafana starts with pre-configured datasources without requiring manual UI configuration.

The datasource configuration is defined in [`grafana/provisioning/datasources/prometheus.yml`](file:///e:/Raguram/ragu/forgeflow/grafana/provisioning/datasources/prometheus.yml):

```yaml
apiVersion: 1

datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    orgId: 1
    url: http://prometheus:9090
    isDefault: true
    version: 1
    editable: false
    jsonData:
      timeInterval: 5s
      httpMethod: POST
```

- **Network Routing**: The URL `http://prometheus:9090` leverages Docker's internal container DNS.
- **Proxy Access**: Grafana backend proxies client requests securely to Prometheus.

---

## 16. Dashboard Architecture & Auto-Provisioning

Dashboards are provisioned declaratively via [`grafana/provisioning/dashboards/dashboards.yml`](file:///e:/Raguram/ragu/forgeflow/grafana/provisioning/dashboards/dashboards.yml), which scans the `/var/lib/grafana/dashboards` volume mount for JSON models.

The primary system dashboard is defined in [`grafana/dashboards/forgeflow-overview.json`](file:///e:/Raguram/ragu/forgeflow/grafana/dashboards/forgeflow-overview.json):
- **UID**: `forgeflow-overview`
- **Refresh Rate**: 5 seconds auto-refresh.
- **Time Window**: Defaults to the last 15 minutes (`now-15m` to `now`).

---

## 17. Dashboard Sections & Operational Panels

The ForgeFlow dashboard is divided into 5 logical sections designed for site reliability engineers (SREs) and operators:

### Section 1: System Overview & Key Metrics (KPIs)
Provides an instant high-level snapshot of platform throughput and backlog:
- **Total Jobs Created** (`stat`): Total count of jobs registered via API (`sum(forgeflow_jobs_created_total)`).
- **Total Jobs Completed** (`stat`): Total count of successfully processed jobs (`sum(forgeflow_worker_jobs_processed_total{status="COMPLETED"})`).
- **Total Job Failures** (`stat`): Total count of worker execution failures (`sum(forgeflow_worker_jobs_failed_total)`).
- **Current Queue Depth** (`stat`): Real-time pending message count in RabbitMQ main queue (`forgeflow_queue_depth{queue="forgeflow.jobs"}`).

### Section 2: API Health & Traffic
Monitors ingress HTTP traffic through the Nginx load balancer to `api1` and `api2`:
- **API Request Rate (req/s)** (`timeseries`): Per-route throughput (`sum(rate(forgeflow_http_requests_total[1m])) by (method, route)`).
- **API Request Latency (p50 & p95)** (`timeseries`): 50th and 95th percentile response times computed from histogram buckets.
- **HTTP Status Code Distribution** (`timeseries`, stacked): Breakdown of HTTP 2xx, 4xx, and 5xx responses over time.

### Section 3: Job Ingestion & Lifecycle
Tracks job creation rates across different workload types:
- **Jobs Created Rate** (`timeseries`): Real-time ingestion rate broken down by job type (`PDF_GENERATION`, `AI_SUMMARY`, `EMAIL`, etc.).
- **API Observed Completions & Failures** (`timeseries`): Rate of job completions/failures observed on the API layer.

### Section 4: Worker & Queue Dynamics
Monitors background execution performance and message broker saturation:
- **Worker Processing Rate** (`timeseries`): Execution rate in jobs/second across worker nodes.
- **Worker Processing Duration (p95)** (`timeseries`): 95th percentile execution duration per job type.
- **RabbitMQ Queue Depth Over Time** (`timeseries`): Historical queue depth trend to identify worker bottlenecks and consumer lag.

### Section 5: Failures, Retries & Dead Letter Queue (DLQ)
Isolates transient faults, retry behavior, and permanent failures:
- **Worker Failure Rate by Category** (`timeseries`): Breakdown of `RETRYABLE` vs `NON_RETRYABLE` execution errors.
- **Worker Retries Scheduled Rate** (`timeseries`): Rate of failed jobs being republished to the delayed retry queue with exponential backoff.
- **Dead Letter Queue (DLQ) Routing Rate** (`timeseries`): Rate of unrecoverable or exhausted messages routed to the DLQ for investigation.

---

## 18. Dashboard Variables & Cardinality Safety

The dashboard includes three template dropdown variables:
1. **`$instance`**: Filters API metrics by instance (`api-1`, `api-2`, or all).
2. **`$job_type`**: Filters metrics by job category (`PDF_GENERATION`, `AI_SUMMARY`, `EMAIL`, `DATA_PROCESSING`).
3. **`$status`**: Filters worker metrics by execution outcome (`COMPLETED`, `FAILED`, `CANCELLED`).

**Safety Guarantee**: Variables are strictly populated from bounded, low-cardinality metric dimensions. Dynamic identifiers (`jobId`, `requestId`, `userId`) are never exposed as Grafana template variables, protecting both Prometheus and Grafana from memory degradation.

---

## 19. Accessing Grafana in Local Development

- **URL**: [http://localhost:3000](http://localhost:3000)
- **Authentication**: Anonymous Admin access is pre-configured for local development (`admin` / `admin`).
- **Dashboard Navigation**: Navigate to **Dashboards** → **ForgeFlow** → **ForgeFlow — System Overview & Telemetry**.

---

# ForgeFlow Observability: OpenTelemetry & Distributed Tracing (Phase 9.4)

## 20. What Distributed Tracing Means

In a distributed, asynchronous platform like ForgeFlow, a single user interaction splits into multiple concurrent operations across network and process boundaries:

```
[Client] ──> [Nginx] ──> [API Instance] ──> [PostgreSQL Outbox] ──> [Outbox Poller] ──> [RabbitMQ] ──> [Worker Node] ──> [PostgreSQL DB]
```

Logs tell us *what happened*, and metrics tell us *system performance in aggregate*. **Distributed tracing** tells us the *causal story and exact timeline* of how an individual request navigated the distributed system from start to finish.

### Trace vs. Span
- **Trace**: Represents the end-to-end journey of an entire execution flow. It is identified by a globally unique 128-bit `traceId` (32 hex characters).
- **Span**: A single contiguous unit of work within a trace. Each span has a unique 64-bit `spanId` (16 hex characters), an operation name, timestamps, attributes, and an optional `parentSpanId`.
- **Trace Tree / Directed Acyclic Graph (DAG)**: A parent span can have multiple child spans (e.g. database queries, message publishes, consumer processing).

### OpenTelemetry vs. Jaeger
- **OpenTelemetry (OTel)**: The vendor-agnostic CNCF standard and SDK used in ForgeFlow application code to create spans, propagate context, and export telemetry data over standard OTLP protocols.
- **Jaeger**: The distributed tracing backend and UI container running locally on port `16686` that receives OTLP trace data (`/v1/traces`), indexes traces, and renders waterfall timeline visualizations.

---

## 21. W3C Trace Context & Asynchronous RabbitMQ Propagation

Distributed tracing across synchronous HTTP calls is straightforward, but asynchronous queue boundaries present a challenge: the HTTP request terminates long before the background worker picks up the message from RabbitMQ.

ForgeFlow solves this via **W3C Trace Context Propagation**:

```
1. HTTP Request (POST /jobs)
   │
   ▼
2. API creates Root Span (traceId: c71ccea..., spanId: 4a2b1c...)
   │
   ▼
3. PostgreSQL Atomic Transaction
   └── Inserts `outbox_events` carrying W3C `traceparent` in JSONB payload:
       "00-c71ccea9068fe19e0c05fd9ba97fef47-4a2b1c8901234567-01"
   │
   ▼
4. Transactional Outbox Publisher claims row
   └── Extracts `traceparent` as parent context
   └── Creates Producer Span: `outbox_publish JOB_CREATED`
   └── Injects `traceparent` into RabbitMQ AMQP message headers
   │
   ▼
5. RabbitMQ Broker Queue (`forgeflow.jobs`)
   │
   ▼
6. Worker Consumer receives AMQP message
   └── Extracts `traceparent` from `msg.properties.headers`
   └── Starts Consumer Span: `job_process AI_SUMMARY` (shares traceId: c71ccea...)
   └── Executes PostgreSQL updates and cache invalidations within trace context
```

---

## 22. The 4 Core Identifiers in ForgeFlow

It is vital never to conflate these four identifiers:

| Identifier | Generation | Scope / Purpose | Example |
| :--- | :--- | :--- | :--- |
| **`requestId`** (`X-Request-ID`) | Gateway / API Correlation Middleware | Identifies the client HTTP request. Propagated through headers and structured logs. | `trace-exp-1790866500212` |
| **`traceId`** | OpenTelemetry SDK (W3C standard) | Identifies the full distributed trace DAG across all processes and brokers. | `c71ccea9068fe19e0c05fd9ba97fef47` |
| **`spanId`** | OpenTelemetry SDK | Identifies a specific operation or execution block within a trace. | `4a2b1c8901234567` |
| **`jobId`** | PostgreSQL Database (UUID v4) | Identifies the domain aggregate / background job record in the database. | `31aec28c-0cf3-4d13-9feb-3ef674eaa7b3` |

---

## 23. Accessing Jaeger in Local Development

- **Jaeger Web UI**: [http://localhost:16686](http://localhost:16686)
- **OTLP Ingestion Endpoints**:
  - HTTP OTLP: `http://localhost:4318/v1/traces`
  - gRPC OTLP: `localhost:4317`
- **Searching Traces in Jaeger**:
  1. Open [http://localhost:16686](http://localhost:16686).
  2. Under **Service**, select `forgeflow-worker` or `forgeflow-api-1` / `forgeflow-api-2`.
  3. Under **Tags**, query specific job executions using `job.id=<UUID>`.
  4. Click **Find Traces** to view the interactive waterfall timeline.

---

## 24. Verified Live Trace Walkthrough

Below is an actual verified distributed trace from the Phase 9.4 live verification experiment:

- **Trace ID**: `c71ccea9068fe19e0c05fd9ba97fef47`
- **Job ID**: `31aec28c-0cf3-4d13-9feb-3ef674eaa7b3`
- **Request ID**: `trace-exp-1790866500212`
- **Total Spans**: 19

```
[forgeflow-api-2] POST /jobs (31ms)
 ├── [forgeflow-api-2] pg.query:INSERT INTO jobs (12ms)
 ├── [forgeflow-api-2] pg.query:INSERT INTO outbox_events (8ms)
 └── [forgeflow-api-2] outbox_publish JOB_CREATED (30ms)
       │
       ▼ (W3C traceparent passed through RabbitMQ AMQP message headers)
       │
 [forgeflow-worker] job_process AI_SUMMARY (2938ms)
  ├── [forgeflow-worker] pg.query:SELECT FROM jobs (45ms)
  ├── [forgeflow-worker] pg.query:INSERT INTO job_executions (25ms)
  ├── [forgeflow-worker] pg.query:UPDATE jobs SET status = 'RUNNING' (12ms)
  ├── [forgeflow-worker] [Simulated Workload Execution] (2500ms)
  ├── [forgeflow-worker] pg.query:BEGIN (8ms)
  ├── [forgeflow-worker] pg.query:UPDATE job_executions SET status = 'COMPLETED' (3ms)
  └── [forgeflow-worker] pg.query:COMMIT (6ms)
```



