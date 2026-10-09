import assert from 'node:assert';
import {
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
  normalizeMetricRoute,
} from '../src/metrics';

async function runMetricsTests() {
  console.log('====================================================');
  console.log('🧪 ForgeFlow Phase 9.2: Shared Metrics Unit Tests');
  console.log('====================================================\n');

  resetMetrics();

  // Test 1: Route normalization to prevent high cardinality
  console.log('▶️ [Test 1] Route Normalization (Low Cardinality Protection)...');
  assert.strictEqual(
    normalizeMetricRoute('/jobs/ca2bebde-685b-4624-b0b0-236af2858242'),
    '/jobs/:id'
  );
  assert.strictEqual(
    normalizeMetricRoute('/jobs/ca2bebde-685b-4624-b0b0-236af2858242/cancel'),
    '/jobs/:id/cancel'
  );
  assert.strictEqual(
    normalizeMetricRoute('/auth/register?referral=123'),
    '/auth/register'
  );
  assert.strictEqual(
    normalizeMetricRoute('/health', '/health'),
    '/health'
  );
  console.log('   ✅ High-cardinality routes correctly normalized to parameterized template.\n');

  // Test 2: HTTP Metrics
  console.log('▶️ [Test 2] API HTTP Request Counter & Duration Histogram...');
  httpRequestsTotal.inc({ method: 'POST', route: '/jobs', status_code: '201' }, 1);
  httpRequestsTotal.inc({ method: 'GET', route: '/health', status_code: '200' }, 3);
  httpRequestDurationSeconds.observe({ method: 'POST', route: '/jobs', status_code: '201' }, 0.045);

  const apiMetricsText = await register.metrics();
  assert.ok(apiMetricsText.includes('forgeflow_http_requests_total{method="POST",route="/jobs",status_code="201"} 1'));
  assert.ok(apiMetricsText.includes('forgeflow_http_requests_total{method="GET",route="/health",status_code="200"} 3'));
  assert.ok(apiMetricsText.includes('forgeflow_http_request_duration_seconds_bucket'));
  assert.ok(apiMetricsText.includes('forgeflow_http_request_duration_seconds_count{method="POST",route="/jobs",status_code="201"} 1'));
  console.log('   ✅ HTTP counters and histograms correctly recorded.\n');

  // Test 3: Job Creation & Lifecycle Counters
  console.log('▶️ [Test 3] Job Lifecycle Counters...');
  jobsCreatedTotal.inc({ type: 'PDF_GENERATION', status: 'PENDING' });
  jobsCompletedTotal.inc({ type: 'PDF_GENERATION' });
  jobsFailedTotal.inc({ type: 'AI_SUMMARY' });

  const jobMetricsText = await register.metrics();
  assert.ok(jobMetricsText.includes('forgeflow_jobs_created_total{type="PDF_GENERATION",status="PENDING"} 1'));
  assert.ok(jobMetricsText.includes('forgeflow_jobs_completed_total{type="PDF_GENERATION"} 1'));
  assert.ok(jobMetricsText.includes('forgeflow_jobs_failed_total{type="AI_SUMMARY"} 1'));
  console.log('   ✅ Job creation and completion counters correctly recorded.\n');

  // Test 4: Queue Depth Gauge
  console.log('▶️ [Test 4] RabbitMQ Queue Depth Gauge...');
  queueDepthGauge.set({ queue: 'forgeflow.jobs' }, 42);
  let metricsText = await register.metrics();
  assert.ok(metricsText.includes('forgeflow_queue_depth{queue="forgeflow.jobs"} 42'));

  queueDepthGauge.set({ queue: 'forgeflow.jobs' }, 0);
  metricsText = await register.metrics();
  assert.ok(metricsText.includes('forgeflow_queue_depth{queue="forgeflow.jobs"} 0'));
  console.log('   ✅ Queue depth gauge accurately reflects state changes.\n');

  // Test 5: Worker Metrics (Processed, Failed, Duration, Skipped, Retry, DLQ)
  console.log('▶️ [Test 5] Worker Processing Metrics...');
  workerJobsProcessedTotal.inc({ type: 'PDF_GENERATION', status: 'COMPLETED' }, 2);
  workerJobsFailedTotal.inc({ type: 'DATA_PROCESSING', error_category: 'RETRYABLE' });
  jobProcessingDurationSeconds.observe({ type: 'PDF_GENERATION', status: 'COMPLETED' }, 2.45);
  workerDuplicateJobsSkippedTotal.inc({ type: 'PDF_GENERATION', reason: 'ALREADY_COMPLETED' });
  workerRetriesScheduledTotal.inc({ type: 'DATA_PROCESSING' });
  workerDlqMessagesTotal.inc({ type: 'EMAIL', reason: 'NON_RETRYABLE' });

  const workerMetricsText = await register.metrics();
  assert.ok(workerMetricsText.includes('forgeflow_worker_jobs_processed_total{type="PDF_GENERATION",status="COMPLETED"} 2'));
  assert.ok(workerMetricsText.includes('forgeflow_worker_jobs_failed_total{type="DATA_PROCESSING",error_category="RETRYABLE"} 1'));
  assert.ok(workerMetricsText.includes('forgeflow_worker_duplicate_jobs_skipped_total{type="PDF_GENERATION",reason="ALREADY_COMPLETED"} 1'));
  assert.ok(workerMetricsText.includes('forgeflow_worker_retries_scheduled_total{type="DATA_PROCESSING"} 1'));
  assert.ok(workerMetricsText.includes('forgeflow_worker_dlq_messages_total{type="EMAIL",reason="NON_RETRYABLE"} 1'));
  console.log('   ✅ Worker metrics (processed, failed, retry, dlq, duplicates) verified.\n');

  // Test 6: Verify Cardinality Guard (no jobId, requestId, or userId in label names)
  console.log('▶️ [Test 6] Cardinality & Label Safety Check...');
  const allMetricDefs = await register.getMetricsAsJSON();
  for (const metric of allMetricDefs) {
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
    }
  }
  console.log('   ✅ Zero high-cardinality labels found across all metrics.\n');

  console.log('====================================================');
  console.log('🎉 ALL METRICS UNIT TESTS PASSED!');
  console.log('====================================================\n');
}

runMetricsTests().catch((err) => {
  console.error('\n❌ Metrics Tests Failed:', err);
  process.exit(1);
});
