import assert from 'node:assert';
import { Pool } from 'pg';
import { processJob } from '../src/processors/jobProcessor';
import { workerDb, pool } from '../src/db';
import { JobQueueMessage } from '@forgeflow/shared';

const testDb = pool;

async function createTestJob(title: string = 'Worker Idempotency Test Job'): Promise<{ jobId: string; userId: string }> {
  // Create test user if not exists
  const userRes = await testDb.query(
    `INSERT INTO users (email, password_hash, name)
     VALUES ($1, 'hash', 'Worker Tester')
     ON CONFLICT (email) DO UPDATE SET updated_at = NOW()
     RETURNING id`,
    [`worker_tester_${Date.now()}@forgeflow.test`]
  );
  const userId = userRes.rows[0].id;

  // Create test job in PENDING state
  const jobRes = await testDb.query(
    `INSERT INTO jobs (user_id, type, payload, status, created_at, updated_at)
     VALUES ($1, 'PDF_GENERATION', '{"test": true}'::jsonb, 'PENDING', NOW(), NOW())
     RETURNING id`,
    [userId]
  );
  const jobId = jobRes.rows[0].id;

  return { jobId, userId };
}

async function runWorkerIdempotencyTests() {
  console.log('====================================================');
  console.log('🧪 ForgeFlow Phase 5: Worker-Side Idempotency Test');
  console.log('====================================================\n');

  // Scenario A: First delivery
  console.log('▶️ [Scenario A] First delivery of Job...');
  const { jobId: jobA } = await createTestJob('Job Scenario A');
  const msgA: JobQueueMessage = {
    jobId: jobA,
    type: 'PDF_GENERATION',
    timestamp: new Date().toISOString(),
  };

  const startA = Date.now();
  const resA = await processJob(msgA);
  const durationA = Date.now() - startA;

  assert.strictEqual(resA.action, 'COMPLETED', 'First processing must return action COMPLETED');
  assert.ok(durationA >= 2400, `First processing must perform simulated ~2.5s workload (actual: ${durationA}ms)`);

  const execA = await workerDb.findExecutionByJobId(jobA);
  assert.ok(execA, 'Execution record must exist in PostgreSQL');
  assert.strictEqual(execA.status, 'COMPLETED', 'Execution status must be COMPLETED');
  assert.ok(execA.completed_at, 'completed_at timestamp must be recorded');

  const dbJobA = await workerDb.findJobById(jobA);
  assert.strictEqual(dbJobA?.status, 'COMPLETED', 'Job status must be COMPLETED');
  console.log(`   ✅ First delivery executed workload (${durationA}ms) and committed COMPLETED execution.\n`);

  // Scenario B: Duplicate delivery after COMPLETED
  console.log('▶️ [Scenario B] Duplicate delivery of already COMPLETED job...');
  const startB = Date.now();
  const resB = await processJob(msgA); // Re-process same message
  const durationB = Date.now() - startB;

  assert.strictEqual(resB.action, 'COMPLETED', 'Replayed processing must return action COMPLETED');
  assert.ok(
    durationB < 500,
    `Duplicate delivery must skip workload and finish immediately (<500ms, actual: ${durationB}ms)`
  );

  const totalExecs = await testDb.query(
    'SELECT COUNT(*) as count FROM job_executions WHERE job_id = $1',
    [jobA]
  );
  assert.strictEqual(parseInt(totalExecs.rows[0].count, 10), 1, 'Exactly 1 execution row must exist');
  console.log(`   ✅ Duplicate delivery detected COMPLETED state and skipped workload (${durationB}ms).\n`);

  // Scenario C: Concurrent duplicate delivery
  console.log('▶️ [Scenario C] Concurrent duplicate delivery (2 workers claiming simultaneously)...');
  const { jobId: jobC } = await createTestJob('Job Scenario C');
  const msgC: JobQueueMessage = {
    jobId: jobC,
    type: 'DATA_PROCESSING',
    timestamp: new Date().toISOString(),
  };

  // Launch 3 simultaneous processJob calls on the same job
  const concurrentResults = await Promise.all([
    processJob(msgC),
    processJob(msgC),
    processJob(msgC),
  ]);

  assert.ok(
    concurrentResults.every((r) => r.action === 'COMPLETED' || r.action === 'SKIP'),
    'All concurrent calls must resolve safely (COMPLETED or SKIP)'
  );
  const execC = await workerDb.findExecutionByJobId(jobC);
  assert.strictEqual(execC?.status, 'COMPLETED');

  const totalExecsC = await testDb.query(
    'SELECT COUNT(*) as count FROM job_executions WHERE job_id = $1',
    [jobC]
  );
  assert.strictEqual(
    parseInt(totalExecsC.rows[0].count, 10),
    1,
    'PostgreSQL UNIQUE constraint must ensure exactly 1 execution record'
  );
  console.log('   ✅ Concurrent deliveries handled safely with single execution claim.\n');

  // Scenario D: Worker crash / stale RUNNING recovery
  console.log('▶️ [Scenario D] Recovery of stale RUNNING execution (simulating worker crash)...');
  const { jobId: jobD } = await createTestJob('Job Scenario D');
  
  // Simulate crashed worker: insert RUNNING execution record with timestamp 60s ago
  await testDb.query(
    `INSERT INTO job_executions (job_id, status, worker_id, started_at, updated_at)
     VALUES ($1, 'RUNNING', 'crashed-worker-node-9', NOW() - INTERVAL '60 seconds', NOW() - INTERVAL '60 seconds')`,
    [jobD]
  );
  await testDb.query(
    `UPDATE jobs SET status = 'RUNNING', started_at = NOW() - INTERVAL '60 seconds' WHERE id = $1`,
    [jobD]
  );

  const msgD: JobQueueMessage = {
    jobId: jobD,
    type: 'AI_SUMMARY',
    timestamp: new Date().toISOString(),
  };

  console.log('   Simulated stale RUNNING execution from crashed worker created.');
  const resD = await processJob(msgD);
  assert.strictEqual(resD.action, 'COMPLETED', 'Recovery processing must return action COMPLETED');

  const execD = await workerDb.findExecutionByJobId(jobD);
  assert.strictEqual(execD?.status, 'COMPLETED', 'Recovered execution must reach COMPLETED status');
  console.log(`   ✅ Stale execution successfully recovered and completed by new worker.\n`);

  // Scenario E: Processing failure
  console.log('▶️ [Scenario E] Processing failure handling...');
  const { jobId: jobE } = await createTestJob('Job Scenario E');
  
  // Intentionally record failure
  await workerDb.failJobAndExecution(jobE, 'Simulated worker memory overflow error');
  const execE = await workerDb.findExecutionByJobId(jobE);
  const dbJobE = await workerDb.findJobById(jobE);

  assert.strictEqual(execE?.status, 'FAILED', 'Failed execution must be FAILED, never falsely COMPLETED');
  assert.strictEqual(dbJobE?.status, 'FAILED', 'Job must be FAILED');
  assert.strictEqual(execE?.error, 'Simulated worker memory overflow error');
  console.log('   ✅ Processing failure correctly recorded as FAILED without false completion.\n');

  console.log('====================================================');
  console.log('🎉 ALL WORKER-SIDE IDEMPOTENCY TESTS PASSED!');
  console.log('====================================================');
}

runWorkerIdempotencyTests()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('\n❌ Worker Idempotency Test Failed:', err);
    await pool.end();
    process.exit(1);
  });
