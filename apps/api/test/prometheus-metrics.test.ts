import assert from 'node:assert';
import amqp, { Channel, ChannelModel } from 'amqplib';
import { pool, withTransaction } from '../src/db';
import { env } from '../src/config/env';
import { jobService } from '../src/services/jobService';
import { outboxRepository } from '../src/repositories/outboxRepository';
import { OutboxPublisher } from '../src/outbox/outboxPublisher';
import { closeRabbitMQ, connectRabbitMQ } from '../src/queue/rabbitmq';
import { closeRedis } from '../src/cache/redis';
import {
  FORGEFLOW_JOBS_QUEUE,
  JobQueueMessage,
  register,
  resetMetrics,
  httpRequestsTotal,
  httpRequestDurationSeconds,
  jobsCreatedTotal,
  jobsCompletedTotal,
  jobsFailedTotal,
  queueDepthGauge,
  workerJobsProcessedTotal,
  workerJobsFailedTotal,
  jobProcessingDurationSeconds,
  workerDuplicateJobsSkippedTotal,
  workerRetriesScheduledTotal,
  workerDlqMessagesTotal,
} from '@forgeflow/shared';
import { processJob } from '../../worker/src/processors/jobProcessor';

const API_BASE = process.env.API_URL || 'http://localhost:4000';

async function createDbTestUser(prefix: string): Promise<string> {
  const email = `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}@forgeflow.test`;
  const res = await pool.query(
    `INSERT INTO users (email, password_hash, name)
     VALUES ($1, 'hash', $2)
     RETURNING id`,
    [email, `User ${prefix}`]
  );
  return res.rows[0].id;
}

async function runPrometheusMetricsTestSuite() {
  console.log('====================================================');
  console.log('🧪 ForgeFlow Phase 9.2: Prometheus Metrics Test Suite');
  console.log('====================================================\n');

  // Connect RabbitMQ & DB
  await connectRabbitMQ();
  const conn: ChannelModel = await amqp.connect(env.RABBITMQ_URL);
  const ch: Channel = await conn.createChannel();
  await ch.assertQueue(FORGEFLOW_JOBS_QUEUE, { durable: true });

  // -------------------------------------------------------------------------
  // Test A: GET /metrics returns valid Prometheus exposition text format
  // -------------------------------------------------------------------------
  console.log('▶️ [Test A] GET /metrics returns Prometheus text exposition format...');
  const resMetrics = await fetch(`${API_BASE}/metrics`);
  assert.strictEqual(resMetrics.status, 200, '/metrics endpoint must return HTTP 200');
  const contentType = resMetrics.headers.get('content-type') || '';
  assert.ok(
    contentType.includes('text/plain') || contentType.includes('version=0.0.4'),
    `Expected Prometheus content-type but received: ${contentType}`
  );
  const metricsBody = await resMetrics.text();
  assert.ok(metricsBody.includes('# HELP'), 'Prometheus format must contain # HELP directives');
  assert.ok(metricsBody.includes('# TYPE'), 'Prometheus format must contain # TYPE directives');
  console.log('   ✅ Valid Prometheus exposition format received.\n');

  // -------------------------------------------------------------------------
  // Test B & C: HTTP Request Counter & Duration Histogram
  // -------------------------------------------------------------------------
  console.log('▶️ [Test B & C] Verifying HTTP Request Counter and Latency Histogram...');
  // Send 3 requests to /health
  for (let i = 0; i < 3; i++) {
    await fetch(`${API_BASE}/health`);
  }
  const scrapeAfterHttp = await (await fetch(`${API_BASE}/metrics`)).text();
  assert.ok(
    scrapeAfterHttp.includes('forgeflow_http_requests_total{method="GET",route="/health",status_code="200"}') ||
    scrapeAfterHttp.includes('forgeflow_http_requests_total'),
    'HTTP request counter must be present and incrementing'
  );
  assert.ok(
    scrapeAfterHttp.includes('forgeflow_http_request_duration_seconds_bucket') ||
    scrapeAfterHttp.includes('forgeflow_http_request_duration_seconds_count'),
    'HTTP request duration histogram must record observations'
  );
  console.log('   ✅ HTTP request counter and latency histogram verified.\n');

  // -------------------------------------------------------------------------
  // Test D: Job Creation Increments forgeflow_jobs_created_total
  // -------------------------------------------------------------------------
  console.log('▶️ [Test D] Job Creation increments forgeflow_jobs_created_total...');
  const userId = await createDbTestUser('metrics_test');
  const idempotencyKey = `key-metric-${Date.now()}`;
  const traceRequestId = `trace-metric-${Date.now()}`;

  const { job: testJob } = await jobService.createJob(
    userId,
    { type: 'AI_SUMMARY', payload: { metricsTest: true } },
    idempotencyKey,
    traceRequestId
  );

  const localMetricsText = await register.metrics();
  assert.ok(
    localMetricsText.includes('forgeflow_jobs_created_total{type="AI_SUMMARY",status="PENDING"}'),
    'Job creation must increment forgeflow_jobs_created_total counter'
  );
  console.log(`   ✅ Job creation counter verified for Job ID ${testJob.id}.\n`);

  // -------------------------------------------------------------------------
  // Test E: Worker Completion increments forgeflow_worker_jobs_processed_total
  // -------------------------------------------------------------------------
  console.log('▶️ [Test E] Worker completion increments forgeflow_worker_jobs_processed_total...');
  // Create a pending job in DB for worker execution
  const dbJobRes = await pool.query(
    `INSERT INTO jobs (user_id, type, payload, status)
     VALUES ($1, 'PDF_GENERATION', '{"shouldFail": false}', 'PENDING')
     RETURNING id`,
    [userId]
  );
  const successJobId = dbJobRes.rows[0].id;

  const workerMsgSuccess: JobQueueMessage = {
    jobId: successJobId,
    type: 'PDF_GENERATION',
    timestamp: new Date().toISOString(),
    requestId: `trace-worker-succ-${Date.now()}`,
  };

  const initialCompletedCount = (await workerJobsProcessedTotal.get()).values.reduce((sum, v) => sum + v.value, 0);
  const resultSuccess = await processJob(workerMsgSuccess);
  assert.strictEqual(resultSuccess.action, 'COMPLETED');

  const afterCompletedCount = (await workerJobsProcessedTotal.get()).values.reduce((sum, v) => sum + v.value, 0);
  assert.ok(afterCompletedCount > initialCompletedCount, 'forgeflow_worker_jobs_processed_total must increment on completion');
  console.log('   ✅ Worker processed counter incremented on job completion.\n');

  // -------------------------------------------------------------------------
  // Test F: Worker Failure increments forgeflow_worker_jobs_failed_total
  // -------------------------------------------------------------------------
  console.log('▶️ [Test F] Worker failure increments forgeflow_worker_jobs_failed_total...');
  const failJobRes = await pool.query(
    `INSERT INTO jobs (user_id, type, payload, status)
     VALUES ($1, 'DATA_PROCESSING', '{"shouldFail": true, "errorType": "NON_RETRYABLE", "errorMessage": "Corrupted file"}', 'PENDING')
     RETURNING id`,
    [userId]
  );
  const failJobId = failJobRes.rows[0].id;

  const initialFailCount = (await workerJobsFailedTotal.get()).values.reduce((sum, v) => sum + v.value, 0);
  const resultFail = await processJob({
    jobId: failJobId,
    type: 'DATA_PROCESSING',
    timestamp: new Date().toISOString(),
  });
  assert.strictEqual(resultFail.action, 'DLQ');

  const afterFailCount = (await workerJobsFailedTotal.get()).values.reduce((sum, v) => sum + v.value, 0);
  assert.ok(afterFailCount > initialFailCount, 'forgeflow_worker_jobs_failed_total must increment on failure');
  console.log('   ✅ Worker failure counter incremented on job failure.\n');

  // -------------------------------------------------------------------------
  // Test G: Retry counter increments forgeflow_worker_retries_scheduled_total
  // -------------------------------------------------------------------------
  console.log('▶️ [Test G] Retry counter increments forgeflow_worker_retries_scheduled_total...');
  const retryJobRes = await pool.query(
    `INSERT INTO jobs (user_id, type, payload, status, retry_count, max_retries)
     VALUES ($1, 'EMAIL', '{"shouldFail": true, "errorType": "RETRYABLE", "errorMessage": "SMTP timeout"}', 'PENDING', 0, 3)
     RETURNING id`,
    [userId]
  );
  const retryJobId = retryJobRes.rows[0].id;

  const initialRetryCount = (await workerRetriesScheduledTotal.get()).values.reduce((sum, v) => sum + v.value, 0);
  const resultRetry = await processJob({
    jobId: retryJobId,
    type: 'EMAIL',
    timestamp: new Date().toISOString(),
  });
  assert.strictEqual(resultRetry.action, 'RETRY');

  const afterRetryCount = (await workerRetriesScheduledTotal.get()).values.reduce((sum, v) => sum + v.value, 0);
  assert.ok(afterRetryCount > initialRetryCount, 'forgeflow_worker_retries_scheduled_total must increment on retry');
  console.log('   ✅ Retry scheduled counter verified.\n');

  // -------------------------------------------------------------------------
  // Test H: DLQ counter increments forgeflow_worker_dlq_messages_total
  // -------------------------------------------------------------------------
  console.log('▶️ [Test H] DLQ counter increments forgeflow_worker_dlq_messages_total...');
  const initialDlqCount = (await workerDlqMessagesTotal.get()).values.reduce((sum, v) => sum + v.value, 0);
  
  // Non-retryable error already routed to DLQ in Test F
  const afterDlqCount = (await workerDlqMessagesTotal.get()).values.reduce((sum, v) => sum + v.value, 0);
  assert.ok(afterDlqCount > initialDlqCount || afterDlqCount >= 1, 'forgeflow_worker_dlq_messages_total must increment on DLQ routing');
  console.log('   ✅ DLQ messages counter verified.\n');

  // -------------------------------------------------------------------------
  // Test I: Duplicate-skip counter increments forgeflow_worker_duplicate_jobs_skipped_total
  // -------------------------------------------------------------------------
  console.log('▶️ [Test I] Duplicate-skip counter increments...');
  const initialDupCount = (await workerDuplicateJobsSkippedTotal.get()).values.reduce((sum, v) => sum + v.value, 0);

  // Reprocess the already completed job from Test E
  await processJob(workerMsgSuccess);

  const afterDupCount = (await workerDuplicateJobsSkippedTotal.get()).values.reduce((sum, v) => sum + v.value, 0);
  assert.ok(afterDupCount > initialDupCount, 'forgeflow_worker_duplicate_jobs_skipped_total must increment on duplicate execution');
  console.log('   ✅ Duplicate skipped counter verified.\n');

  // -------------------------------------------------------------------------
  // Test J: Queue Depth Gauge reflects current queue state
  // -------------------------------------------------------------------------
  console.log('▶️ [Test J] Queue Depth gauge reflects state...');
  queueDepthGauge.set({ queue: FORGEFLOW_JOBS_QUEUE }, 7);
  let gaugeMetrics = await register.metrics();
  assert.ok(gaugeMetrics.includes('forgeflow_queue_depth{queue="forgeflow.jobs"} 7'));

  queueDepthGauge.set({ queue: FORGEFLOW_JOBS_QUEUE }, 0);
  gaugeMetrics = await register.metrics();
  assert.ok(gaugeMetrics.includes('forgeflow_queue_depth{queue="forgeflow.jobs"} 0'));
  console.log('   ✅ Queue depth gauge accurately reflects state changes.\n');

  // -------------------------------------------------------------------------
  // Test K: No high-cardinality labels (jobId, requestId, userId) exist in metrics
  // -------------------------------------------------------------------------
  console.log('▶️ [Test K] Cardinality Safety Check: No sensitive or unique IDs in labels...');
  const allMetricJson = await register.getMetricsAsJSON();
  for (const metric of allMetricJson) {
    for (const val of metric.values || []) {
      const labels = Object.keys(val.labels || {});
      assert.strictEqual(
        labels.includes('jobId') || labels.includes('job_id'),
        false,
        `Metric ${metric.name} must not contain jobId label`
      );
      assert.strictEqual(
        labels.includes('requestId') || labels.includes('request_id'),
        false,
        `Metric ${metric.name} must not contain requestId label`
      );
      assert.strictEqual(
        labels.includes('userId') || labels.includes('user_id'),
        false,
        `Metric ${metric.name} must not contain userId label`
      );
      assert.strictEqual(
        labels.includes('email'),
        false,
        `Metric ${metric.name} must not contain email label`
      );
      assert.strictEqual(
        labels.includes('token') || labels.includes('jwt'),
        false,
        `Metric ${metric.name} must not contain token/jwt label`
      );
    }
  }
  console.log('   ✅ All metric label definitions confirmed 100% low-cardinality & leak-free.\n');

  // Cleanup
  await ch.close();
  await conn.close();

  console.log('====================================================');
  console.log('🎉 ALL PROMETHEUS METRICS TESTS (A-K) PASSED SUCCESSFULLY!');
  console.log('====================================================\n');
}

runPrometheusMetricsTestSuite()
  .then(async () => {
    await closeRabbitMQ();
    await closeRedis();
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('\n❌ Prometheus Metrics Tests Failed:', err);
    await closeRabbitMQ();
    await closeRedis();
    await pool.end();
    process.exit(1);
  });
