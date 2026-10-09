import assert from 'node:assert';
import amqp, { Channel, ChannelModel } from 'amqplib';
import { pool, withTransaction } from '../src/db';
import { env } from '../src/config/env';
import { jobService } from '../src/services/jobService';
import { jobRepository } from '../src/repositories/jobRepository';
import { outboxRepository } from '../src/repositories/outboxRepository';
import { OutboxPublisher } from '../src/outbox/outboxPublisher';
import { closeRabbitMQ, connectRabbitMQ, isRabbitMQReady } from '../src/queue/rabbitmq';
import { closeRedis } from '../src/cache/redis';
import { FORGEFLOW_JOBS_QUEUE, JobQueueMessage } from '@forgeflow/shared';
import { processJob } from '../../worker/src/processors/jobProcessor';

async function createTestUser(prefix: string): Promise<string> {
  const email = `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}@forgeflow.test`;
  const res = await pool.query(
    `INSERT INTO users (email, password_hash, name)
     VALUES ($1, 'hash', $2)
     RETURNING id`,
    [email, `User ${prefix}`]
  );
  return res.rows[0].id;
}

async function runOutboxTests() {
  console.log('====================================================');
  console.log('🧪 ForgeFlow Phase 7: Transactional Outbox Test Suite');
  console.log('====================================================\n');

  // Ensure RabbitMQ is connected for testing
  await connectRabbitMQ();
  const conn: ChannelModel = await amqp.connect(env.RABBITMQ_URL);
  const ch: Channel = await conn.createChannel();
  await ch.assertQueue(FORGEFLOW_JOBS_QUEUE, { durable: true });
  await ch.purgeQueue(FORGEFLOW_JOBS_QUEUE);

  // Clean test tables for test isolation
  await pool.query('DELETE FROM outbox_events');

  const publisher = new OutboxPublisher(500);

  // -------------------------------------------------------------------------
  // Test A: Atomic Commit of Job + Idempotency Key + Outbox Event
  // -------------------------------------------------------------------------
  console.log('▶️ [Test A] Atomic Commit of Job + Idempotency Key + Outbox Event...');
  const userIdA = await createTestUser('atomic_commit');
  const idempotencyKeyA = `key-atomic-${Date.now()}`;

  const { job: jobA, isIdempotentReplay: replayA } = await jobService.createJob(
    userIdA,
    { type: 'PDF_GENERATION', payload: { test: 'atomic' } },
    idempotencyKeyA
  );

  assert.strictEqual(replayA, false);
  assert.strictEqual(jobA.status, 'PENDING');

  // Verify Job in DB
  const dbJobA = await jobRepository.findById(jobA.id, userIdA);
  assert.ok(dbJobA, 'Job record must exist in PostgreSQL');

  // Verify Outbox Event in DB
  const outboxEventsA = await outboxRepository.findByAggregate('JOB', jobA.id);
  assert.strictEqual(outboxEventsA.length, 1, 'Exactly 1 outbox event must be created');
  const eventA = outboxEventsA[0];
  assert.strictEqual(eventA.event_type, 'JOB_CREATED');
  assert.strictEqual(eventA.aggregate_id, jobA.id);
  assert.ok(eventA.payload.jobId === jobA.id);
  console.log(`   ✅ Atomic commit verified: Job ${jobA.id} created with Outbox Event ${eventA.id}.\n`);

  // -------------------------------------------------------------------------
  // Test B: Transaction Rollback Leaves Neither Job Nor Outbox Event
  // -------------------------------------------------------------------------
  console.log('▶️ [Test B] Transaction Rollback Atomicity...');
  const userIdB = await createTestUser('rollback_test');
  const idempotencyKeyB = `key-rollback-${Date.now()}`;

  let caughtError = false;
  try {
    await withTransaction(async (client) => {
      const jobRow = await jobRepository.create(
        userIdB,
        'DATA_PROCESSING',
        { test: 'rollback' },
        client
      );

      await outboxRepository.create(
        {
          eventType: 'JOB_CREATED',
          aggregateType: 'JOB',
          aggregateId: jobRow.id,
          payload: { jobId: jobRow.id },
        },
        client
      );

      // Force an intentional error to trigger ROLLBACK
      throw new Error('SIMULATED_DB_ERROR_FORCE_ROLLBACK');
    });
  } catch (err: any) {
    if (err.message === 'SIMULATED_DB_ERROR_FORCE_ROLLBACK') {
      caughtError = true;
    }
  }

  assert.ok(caughtError, 'Transaction must throw the simulated error');

  // Verify no orphaned records exist
  const countJobsRes = await pool.query(
    "SELECT COUNT(*) as count FROM jobs WHERE user_id = $1 AND payload->>'test' = 'rollback'",
    [userIdB]
  );
  assert.strictEqual(parseInt(countJobsRes.rows[0].count, 10), 0, 'No jobs must exist after rollback');

  const countOutboxRes = await pool.query(
    "SELECT COUNT(*) as count FROM outbox_events WHERE payload->>'test' = 'rollback'"
  );
  assert.strictEqual(parseInt(countOutboxRes.rows[0].count, 10), 0, 'No outbox events must exist after rollback');
  console.log('   ✅ Transaction rollback leaves zero orphaned jobs or outbox rows.\n');

  // -------------------------------------------------------------------------
  // Test C: Outbox Event Claiming & RabbitMQ Publishing
  // -------------------------------------------------------------------------
  console.log('▶️ [Test C] Outbox Event Claiming & Publishing...');
  // Purge test queue
  await ch.purgeQueue(FORGEFLOW_JOBS_QUEUE);

  const userIdC = await createTestUser('publish_test');
  const { job: jobC } = await jobService.createJob(
    userIdC,
    { type: 'AI_SUMMARY', payload: { summaryId: 42 } },
    `key-publish-${Date.now()}`
  );

  // Process outbox batch
  const processedCount = await publisher.processBatch(10);
  assert.ok(processedCount >= 1, 'At least 1 outbox event should be processed');

  // Verify Outbox Event is marked PUBLISHED
  const outboxEventsC = await outboxRepository.findByAggregate('JOB', jobC.id);
  assert.strictEqual(outboxEventsC[0].status, 'PUBLISHED');
  assert.ok(outboxEventsC[0].published_at !== null);

  // Verify that the message was dispatched (either in queue or consumed by worker)
  const rmqMsg = await ch.get(FORGEFLOW_JOBS_QUEUE, { noAck: true });
  if (rmqMsg) {
    const parsedMsg = JSON.parse(rmqMsg.content.toString()) as JobQueueMessage;
    assert.strictEqual(parsedMsg.jobId, jobC.id);
  } else {
    // If live worker consumed it, verify job status in DB
    const dbJobC = await jobRepository.findById(jobC.id);
    assert.ok(dbJobC?.status === 'PENDING' || dbJobC?.status === 'RUNNING' || dbJobC?.status === 'COMPLETED');
  }
  console.log(`   ✅ Outbox event claimed, published to '${FORGEFLOW_JOBS_QUEUE}', and marked PUBLISHED.\n`);

  // -------------------------------------------------------------------------
  // Test D: Failed RabbitMQ Publish Remains Retryable
  // -------------------------------------------------------------------------
  console.log('▶️ [Test D] Failed Publish Attempt Records Failure & Backoff...');
  const userIdD = await createTestUser('fail_publish');
  
  // Insert outbox event directly with unavailable state simulation
  const failedEvent = await outboxRepository.create({
    eventType: 'JOB_CREATED',
    aggregateType: 'JOB',
    aggregateId: '00000000-0000-0000-0000-000000000001',
    payload: { jobId: '00000000-0000-0000-0000-000000000001', type: 'CUSTOM' },
  });

  // Record simulated network error
  const retryTime = new Date(Date.now() + 5000);
  await outboxRepository.recordPublishFailure(
    failedEvent.id,
    'Simulated RabbitMQ connection reset during publish',
    retryTime
  );

  const updatedFailed = await outboxRepository.findById(failedEvent.id);
  assert.strictEqual(updatedFailed?.status, 'FAILED');
  assert.strictEqual(updatedFailed?.attempts, 1);
  assert.strictEqual(updatedFailed?.last_error, 'Simulated RabbitMQ connection reset during publish');
  assert.ok(updatedFailed!.available_at.getTime() >= Date.now() + 4000);
  console.log(`   ✅ Failed publishing recorded status=FAILED with attempts=${updatedFailed?.attempts} and future available_at.\n`);

  // -------------------------------------------------------------------------
  // Test E: Concurrent Publishers Claiming (FOR UPDATE SKIP LOCKED)
  // -------------------------------------------------------------------------
  console.log('▶️ [Test E] Concurrent Publishers Claiming without Collision...');
  await pool.query('DELETE FROM outbox_events');
  await ch.purgeQueue(FORGEFLOW_JOBS_QUEUE);

  const userIdE = await createTestUser('concurrent_publish');

  // Insert 10 pending jobs + outbox events
  const eventIdsE: string[] = [];
  for (let i = 0; i < 10; i++) {
    const jobE = await jobRepository.create(userIdE, 'EMAIL', { index: i });
    const ev = await outboxRepository.create({
      eventType: 'JOB_CREATED',
      aggregateType: 'JOB',
      aggregateId: jobE.id,
      payload: { jobId: jobE.id, type: 'EMAIL', timestamp: jobE.created_at.toISOString() },
    });
    eventIdsE.push(ev.id);
  }

  // Run 3 publisher batch processors simultaneously
  const publisherA = new OutboxPublisher();
  const publisherB = new OutboxPublisher();
  const publisherC = new OutboxPublisher();

  const results = await Promise.all([
    publisherA.processBatch(10),
    publisherB.processBatch(10),
    publisherC.processBatch(10),
  ]);

  const totalClaimed = results.reduce((sum, n) => sum + n, 0);
  assert.strictEqual(totalClaimed, 10, 'All 10 events must be claimed across concurrent workers exactly once');

  // Verify all 10 are now PUBLISHED
  for (const eid of eventIdsE) {
    const event = await outboxRepository.findById(eid);
    assert.strictEqual(event?.status, 'PUBLISHED');
  }
  console.log(`   ✅ Concurrent claim batch sizes: [${results.join(', ')}]. Total: ${totalClaimed}/10 published with zero collisions.\n`);

  // -------------------------------------------------------------------------
  // Test F: Crash Scenario & Failure Experiment
  // (Simulate crash between RabbitMQ publish and outbox status update)
  // -------------------------------------------------------------------------
  console.log('▶️ [Test F] Crash Simulation & At-Least-Once Delivery Safety...');
  await pool.query('DELETE FROM outbox_events');
  await ch.purgeQueue(FORGEFLOW_JOBS_QUEUE);

  const userIdF = await createTestUser('crash_experiment');
  
  // Insert job and outbox event directly in transaction
  const jobF = await withTransaction(async (client) => {
    const j = await jobRepository.create(
      userIdF,
      'PDF_GENERATION',
      { shouldFail: false },
      client
    );
    await outboxRepository.create(
      {
        eventType: 'JOB_CREATED',
        aggregateType: 'JOB',
        aggregateId: j.id,
        payload: {
          jobId: j.id,
          type: j.type,
          timestamp: j.created_at.toISOString(),
        },
      },
      client
    );
    return j;
  });

  const [eventF] = await outboxRepository.findByAggregate('JOB', jobF.id);
  assert.ok(eventF, 'Outbox event for jobF must exist');

  // 1. Manually claim event and publish to RabbitMQ, then simulate crash (rollback / drop connection before marking PUBLISHED)
  const clientCrash = await pool.connect();
  await clientCrash.query('BEGIN');
  const claimRes = await clientCrash.query(
    'SELECT * FROM outbox_events WHERE id = $1 FOR UPDATE',
    [eventF.id]
  );
  const claimedEvent = claimRes.rows[0];
  assert.ok(claimedEvent, 'Event must be claimable');

  // Publish to RabbitMQ (First delivery)
  await ch.sendToQueue(
    FORGEFLOW_JOBS_QUEUE,
    Buffer.from(JSON.stringify(claimedEvent.payload)),
    { persistent: true }
  );

  // SIMULATE CRASH: Roll back transaction without marking PUBLISHED
  await clientCrash.query('ROLLBACK');
  clientCrash.release();
  console.log('   Simulated publisher crash immediately after RabbitMQ publish.');

  // 2. Outbox event is still PENDING in PostgreSQL
  const eventAfterCrash = await outboxRepository.findById(claimedEvent.id);
  assert.strictEqual(eventAfterCrash?.status, 'PENDING', 'Event must remain PENDING after publisher crash');

  // 3. Publisher recovers and runs next batch -> re-publishes event to RabbitMQ (Duplicate delivery in queue)
  const recoveredCount = await publisher.processBatch(1);
  assert.strictEqual(recoveredCount, 1, 'Recovered publisher must re-claim and publish the pending event');

  const eventAfterRecovery = await outboxRepository.findById(claimedEvent.id);
  assert.strictEqual(eventAfterRecovery?.status, 'PUBLISHED', 'Event is now successfully marked PUBLISHED');

  // 4. Verify worker idempotency and duplicate delivery safety
  // Process First Delivery
  const queueMsgF: JobQueueMessage = {
    jobId: jobF.id,
    type: jobF.type,
    timestamp: jobF.created_at.toISOString(),
  };

  const firstRun = await processJob(queueMsgF);
  assert.strictEqual(firstRun.action, 'COMPLETED', 'First delivery must execute and complete');

  // Process Duplicate Delivery (caused by crash recovery)
  const duplicateRun = await processJob(queueMsgF);
  assert.strictEqual(duplicateRun.action, 'COMPLETED', 'Duplicate delivery must be safely handled by idempotency');

  const countExecRes = await pool.query(
    'SELECT COUNT(*) as count FROM job_executions WHERE job_id = $1',
    [jobF.id]
  );
  assert.strictEqual(
    parseInt(countExecRes.rows[0].count, 10),
    1,
    'Worker idempotency MUST ensure exactly 1 execution record exists even with duplicate publishes'
  );

  const finalJobF = await jobRepository.findById(jobF.id);
  assert.strictEqual(finalJobF?.status, 'COMPLETED');
  console.log('   ✅ At-least-once guarantee & Worker Idempotency confirmed: Zero duplicate executions.\n');

  // Clean up test channel & connection
  await ch.close();
  await conn.close();

  console.log('====================================================');
  console.log('🎉 ALL TRANSACTIONAL OUTBOX TESTS PASSED SUCCESSFULLY!');
  console.log('====================================================');
}

runOutboxTests()
  .then(async () => {
    await closeRabbitMQ();
    await closeRedis();
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('\n❌ Outbox Tests Failed:', err);
    await closeRabbitMQ();
    await closeRedis();
    await pool.end();
    process.exit(1);
  });

