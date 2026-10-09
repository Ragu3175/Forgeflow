import assert from 'node:assert';
import { processJob } from '../src/processors/jobProcessor';
import { workerDb, pool } from '../src/db';
import { JobQueueMessage } from '@forgeflow/shared';

const testDb = pool;

async function createTestJob(
  title: string,
  payload: Record<string, any> = {},
  maxRetries: number = 3
): Promise<{ jobId: string; userId: string }> {
  const userRes = await testDb.query(
    `INSERT INTO users (email, password_hash, name)
     VALUES ($1, 'hash', 'Retry Tester')
     ON CONFLICT (email) DO UPDATE SET updated_at = NOW()
     RETURNING id`,
    [`retry_tester_${Date.now()}_${Math.random().toString(36).substring(2, 6)}@forgeflow.test`]
  );
  const userId = userRes.rows[0].id;

  const jobRes = await testDb.query(
    `INSERT INTO jobs (user_id, type, payload, status, retry_count, max_retries, created_at, updated_at)
     VALUES ($1, 'PDF_GENERATION', $2, 'PENDING', 0, $3, NOW(), NOW())
     RETURNING id`,
    [userId, JSON.stringify(payload), maxRetries]
  );
  const jobId = jobRes.rows[0].id;

  return { jobId, userId };
}

async function runWorkerRetryTests() {
  console.log('====================================================');
  console.log('🧪 ForgeFlow Phase 6.1: Worker Retry Integration Tests');
  console.log('====================================================\n');

  // -------------------------------------------------------------------------
  // Scenario A: First failure with a Retryable Error
  // -------------------------------------------------------------------------
  console.log('▶️ [Scenario A] First failure with Retryable Error...');
  const { jobId: jobA } = await createTestJob('Job A - Retryable', {
    shouldFail: true,
    errorType: 'RETRYABLE',
    errorMessage: 'ETIMEDOUT connecting to upstream PDF rendering service',
  });

  const msgA: JobQueueMessage = {
    jobId: jobA,
    type: 'PDF_GENERATION',
    timestamp: new Date().toISOString(),
  };

  const resA = await processJob(msgA);
  assert.strictEqual(resA.action, 'RETRY', 'First retryable failure must return action RETRY');

  const dbJobA = await workerDb.findJobById(jobA);
  assert.ok(dbJobA, 'Job must exist in PostgreSQL');
  assert.strictEqual(dbJobA.retry_count, 1, 'retry_count must increment from 0 to 1 on first retryable failure');
  assert.strictEqual(dbJobA.status, 'PENDING', 'Job status must remain PENDING (eligible for next retry attempt)');
  assert.ok(dbJobA.next_retry_at, 'next_retry_at timestamp must be calculated and stored');
  assert.strictEqual(
    dbJobA.last_error,
    'ETIMEDOUT connecting to upstream PDF rendering service',
    'last_error must be durably recorded in PostgreSQL'
  );

  const execA = await workerDb.findExecutionByJobId(jobA);
  assert.strictEqual(execA?.status, 'FAILED', 'job_executions record must be marked FAILED for this attempt');
  console.log(`   ✅ First failure incremented retry_count to ${dbJobA.retry_count}, scheduled next_retry_at: ${dbJobA.next_retry_at?.toISOString()}.\n`);

  // -------------------------------------------------------------------------
  // Scenario B: Second failure with Retryable Error
  // -------------------------------------------------------------------------
  console.log('▶️ [Scenario B] Second failure of same job increments retry_count again...');
  const prevRetryAt = dbJobA.next_retry_at!.getTime();

  const resA2 = await processJob(msgA);
  assert.strictEqual(resA2.action, 'RETRY', 'Second retryable failure must return action RETRY');

  const dbJobA2 = await workerDb.findJobById(jobA);
  assert.strictEqual(dbJobA2?.retry_count, 2, 'retry_count must increment from 1 to 2');
  assert.strictEqual(dbJobA2?.status, 'PENDING', 'Job status must remain PENDING for retry');
  assert.ok(dbJobA2?.next_retry_at, 'next_retry_at must be updated');
  assert.ok(
    dbJobA2!.next_retry_at!.getTime() > prevRetryAt,
    'Second next_retry_at must be further in the future due to exponential backoff'
  );
  console.log(`   ✅ Second failure incremented retry_count to ${dbJobA2.retry_count}, updated next_retry_at: ${dbJobA2.next_retry_at?.toISOString()}.\n`);

  // -------------------------------------------------------------------------
  // Scenario E: Non-Retryable Error (Immediate Failure)
  // -------------------------------------------------------------------------
  console.log('▶️ [Scenario E] Non-Retryable Error (e.g. Invalid Payload)...');
  const { jobId: jobE } = await createTestJob('Job E - NonRetryable', {
    shouldFail: true,
    errorType: 'NON_RETRYABLE',
    errorMessage: 'Invalid payload: missing required field "documentId"',
  });

  const msgE: JobQueueMessage = {
    jobId: jobE,
    type: 'PDF_GENERATION',
    timestamp: new Date().toISOString(),
  };

  const resE = await processJob(msgE);
  assert.strictEqual(resE.action, 'DLQ', 'Non-retryable failure must return action DLQ');
  if (resE.action === 'DLQ') {
    assert.strictEqual(resE.reason, 'NON_RETRYABLE');
  }

  const dbJobE = await workerDb.findJobById(jobE);
  assert.strictEqual(dbJobE?.status, 'FAILED', 'Non-retryable error must immediately mark job as FAILED');
  assert.strictEqual(dbJobE?.retry_count, 0, 'retry_count must NOT increment for non-retryable errors');
  assert.strictEqual(dbJobE?.next_retry_at, null, 'next_retry_at must be null for non-retryable errors');
  assert.strictEqual(
    dbJobE?.last_error,
    'Invalid payload: missing required field "documentId"',
    'last_error must be durably recorded'
  );
  console.log('   ✅ Non-retryable error immediately marked as FAILED with zero retries scheduled.\n');

  // -------------------------------------------------------------------------
  // Scenario F: Retries Exhaustion (Reaching max_retries)
  // -------------------------------------------------------------------------
  console.log('▶️ [Scenario F] Retries Exhaustion (Reaching max_retries limit)...');
  // Create job with max_retries = 2, currently at retry_count = 1
  const { jobId: jobF } = await createTestJob('Job F - Exhaustion', {
    shouldFail: true,
    errorType: 'RETRYABLE',
    errorMessage: 'Persistent upstream outage (503 Service Unavailable)',
  }, 2);

  // Set retry_count to 1 in DB
  await testDb.query('UPDATE jobs SET retry_count = 1 WHERE id = $1', [jobF]);

  const msgF: JobQueueMessage = {
    jobId: jobF,
    type: 'PDF_GENERATION',
    timestamp: new Date().toISOString(),
  };

  // This attempt will increment retry_count to 2 (reaching max_retries = 2)
  const resF1 = await processJob(msgF);
  assert.strictEqual(resF1.action, 'RETRY');

  const dbJobF1 = await workerDb.findJobById(jobF);
  assert.strictEqual(dbJobF1?.retry_count, 2, 'retry_count reached max_retries = 2');

  // Next attempt triggers exhaustion
  const resF2 = await processJob(msgF);
  assert.strictEqual(resF2.action, 'DLQ');
  if (resF2.action === 'DLQ') {
    assert.strictEqual(resF2.reason, 'MAX_RETRIES_EXHAUSTED');
  }

  const dbJobF2 = await workerDb.findJobById(jobF);
  assert.strictEqual(dbJobF2?.status, 'FAILED', 'Job must be permanently FAILED when retries are exhausted');
  assert.strictEqual(dbJobF2?.next_retry_at, null, 'next_retry_at must be cleared when retries are exhausted');
  assert.ok(
    dbJobF2?.last_error?.includes('Max retries exhausted'),
    `last_error must indicate retries exhaustion (got: "${dbJobF2?.last_error}")`
  );
  console.log(`   ✅ Retries exhaustion permanently marked job as FAILED with error: "${dbJobF2?.last_error}".\n`);

  // -------------------------------------------------------------------------
  // Scenario H: Worker Idempotency Preservation
  // -------------------------------------------------------------------------
  console.log('▶️ [Scenario H] Worker Idempotency Preservation on COMPLETED job...');
  const { jobId: jobH } = await createTestJob('Job H - Successful', { shouldFail: false });
  const msgH: JobQueueMessage = {
    jobId: jobH,
    type: 'PDF_GENERATION',
    timestamp: new Date().toISOString(),
  };

  const firstRun = await processJob(msgH);
  assert.strictEqual(firstRun.action, 'COMPLETED', 'First normal run must return COMPLETED');

  const dbJobH = await workerDb.findJobById(jobH);
  assert.strictEqual(dbJobH?.status, 'COMPLETED');

  // Replay message
  const startReplay = Date.now();
  const replayRun = await processJob(msgH);
  const replayDuration = Date.now() - startReplay;

  assert.strictEqual(replayRun.action, 'COMPLETED', 'Replay must return COMPLETED');
  assert.ok(replayDuration < 500, `Replay must skip workload (duration: ${replayDuration}ms)`);
  console.log(`   ✅ Idempotency strictly preserved: COMPLETED job skipped duplicate execution (${replayDuration}ms).\n`);

  console.log('====================================================');
  console.log('🎉 ALL WORKER RETRY INTEGRATION TESTS PASSED!');
  console.log('====================================================');
}

runWorkerRetryTests()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('\n❌ Integration Tests Failed:', err);
    await pool.end();
    process.exit(1);
  });
