import assert from 'node:assert';
import amqp, { Channel, ChannelModel } from 'amqplib';
import { env } from '../src/config/env';
import {
  FORGEFLOW_JOBS_QUEUE,
  FORGEFLOW_RETRY_EXCHANGE,
  FORGEFLOW_RETRY_QUEUE,
  FORGEFLOW_RETRY_ROUTING_KEY,
  FORGEFLOW_DLX_EXCHANGE,
  FORGEFLOW_DLQ_QUEUE,
  FORGEFLOW_DLQ_ROUTING_KEY,
  JobQueueMessage,
} from '@forgeflow/shared';
import { processJob } from '../src/processors/jobProcessor';
import { publishToRetry, publishToDLQ } from '../src/queue/publisher';
import { workerDb, pool } from '../src/db';

const testDb = pool;

async function createTestJob(
  payload: Record<string, any> = {},
  maxRetries: number = 3
): Promise<{ jobId: string; userId: string }> {
  const userRes = await testDb.query(
    `INSERT INTO users (email, password_hash, name)
     VALUES ($1, 'hash', 'DLQ Tester')
     ON CONFLICT (email) DO UPDATE SET updated_at = NOW()
     RETURNING id`,
    [`dlq_tester_${Date.now()}_${Math.random().toString(36).substring(2, 6)}@forgeflow.test`]
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

async function runRabbitMQRetryAndDlqTests() {
  console.log('====================================================');
  console.log('🧪 ForgeFlow Phase 6.2: RabbitMQ Retry & DLQ Tests');
  console.log('====================================================\n');

  console.log(`▶️ Connecting to RabbitMQ at ${env.RABBITMQ_URL}...`);
  const conn: ChannelModel = await amqp.connect(env.RABBITMQ_URL);
  const ch: Channel = await conn.createChannel();

  // Ensure topology is asserted
  await ch.assertExchange(FORGEFLOW_DLX_EXCHANGE, 'direct', { durable: true });
  await ch.assertQueue(FORGEFLOW_DLQ_QUEUE, { durable: true });
  await ch.bindQueue(FORGEFLOW_DLQ_QUEUE, FORGEFLOW_DLX_EXCHANGE, FORGEFLOW_DLQ_ROUTING_KEY);

  await ch.assertExchange(FORGEFLOW_RETRY_EXCHANGE, 'direct', { durable: true });
  await ch.assertQueue(FORGEFLOW_RETRY_QUEUE, {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': '',
      'x-dead-letter-routing-key': FORGEFLOW_JOBS_QUEUE,
    },
  });
  await ch.bindQueue(FORGEFLOW_RETRY_QUEUE, FORGEFLOW_RETRY_EXCHANGE, FORGEFLOW_RETRY_ROUTING_KEY);

  await ch.assertQueue(FORGEFLOW_JOBS_QUEUE, { durable: true });
  console.log('   ✅ Topology asserted successfully.\n');

  // Purge test queues to start fresh
  await ch.purgeQueue(FORGEFLOW_DLQ_QUEUE);
  await ch.purgeQueue(FORGEFLOW_RETRY_QUEUE);
  await ch.purgeQueue(FORGEFLOW_JOBS_QUEUE);

  // -------------------------------------------------------------------------
  // Test 1: Successful Job Execution (No Retry, No DLQ)
  // -------------------------------------------------------------------------
  console.log('▶️ [Test 1] Successful Job (COMPLETED -> No Retry, No DLQ)...');
  const { jobId: job1 } = await createTestJob({ shouldFail: false });
  const msg1: JobQueueMessage = {
    jobId: job1,
    type: 'PDF_GENERATION',
    timestamp: new Date().toISOString(),
  };

  const res1 = await processJob(msg1);
  assert.strictEqual(res1.action, 'COMPLETED', 'Successful job must return action COMPLETED');

  const dbJob1 = await workerDb.findJobById(job1);
  assert.strictEqual(dbJob1?.status, 'COMPLETED');
  console.log(`   ✅ Successful job processed cleanly: status=${dbJob1?.status}.\n`);

  // -------------------------------------------------------------------------
  // Test 2: Retryable Failure -> Routing to Retry Delay Queue
  // -------------------------------------------------------------------------
  console.log('▶️ [Test 2] Retryable Failure -> Route to Retry Queue with TTL...');
  const { jobId: job2 } = await createTestJob({
    shouldFail: true,
    errorType: 'RETRYABLE',
    errorMessage: 'ETIMEDOUT connecting to remote server',
  });
  const msg2: JobQueueMessage = {
    jobId: job2,
    type: 'PDF_GENERATION',
    timestamp: new Date().toISOString(),
  };

  const res2 = await processJob(msg2);
  assert.strictEqual(res2.action, 'RETRY', 'Retryable error must return action RETRY');
  if (res2.action === 'RETRY') {
    assert.strictEqual(res2.retryCount, 1);
    assert.ok(res2.delayMs >= 1000, `Delay must be >= 1000ms (actual: ${res2.delayMs}ms)`);

    // Publish to retry queue
    await publishToRetry(ch, msg2, res2.delayMs, { retryCount: res2.retryCount, error: res2.error });
  }

  const dbJob2 = await workerDb.findJobById(job2);
  assert.strictEqual(dbJob2?.status, 'PENDING');
  assert.strictEqual(dbJob2?.retry_count, 1);
  assert.ok(dbJob2?.next_retry_at);

  // Check that message is in retry delay queue
  const retryQueueInfo = await ch.checkQueue(FORGEFLOW_RETRY_QUEUE);
  assert.strictEqual(retryQueueInfo.messageCount, 1, 'Retry queue must contain 1 delayed message');
  console.log(`   ✅ Retryable failure routed to '${FORGEFLOW_RETRY_QUEUE}' with TTL. Message count: ${retryQueueInfo.messageCount}.\n`);

  // -------------------------------------------------------------------------
  // Test 3: Non-Retryable Failure -> Routing directly to DLQ
  // -------------------------------------------------------------------------
  console.log('▶️ [Test 3] Non-Retryable Failure -> Route directly to DLQ...');
  const { jobId: job3 } = await createTestJob({
    shouldFail: true,
    errorType: 'NON_RETRYABLE',
    errorMessage: 'Invalid payload: missing template ID',
  });
  const msg3: JobQueueMessage = {
    jobId: job3,
    type: 'PDF_GENERATION',
    timestamp: new Date().toISOString(),
  };

  const res3 = await processJob(msg3);
  assert.strictEqual(res3.action, 'DLQ', 'Non-retryable error must return action DLQ');
  if (res3.action === 'DLQ') {
    assert.strictEqual(res3.reason, 'NON_RETRYABLE');
    await publishToDLQ(ch, msg3, { reason: res3.reason, error: res3.error, retryCount: res3.retryCount });
  }

  const dbJob3 = await workerDb.findJobById(job3);
  assert.strictEqual(dbJob3?.status, 'FAILED');
  assert.strictEqual(dbJob3?.retry_count, 0);

  const dlqInfo3 = await ch.checkQueue(FORGEFLOW_DLQ_QUEUE);
  assert.strictEqual(dlqInfo3.messageCount, 1, 'DLQ must receive the non-retryable message');

  // Consume from DLQ and verify headers
  const dlqMsg = await ch.get(FORGEFLOW_DLQ_QUEUE, { noAck: true });
  assert.ok(dlqMsg, 'DLQ message must be retrievable');
  assert.strictEqual(dlqMsg.properties.headers['x-rejection-reason'], 'NON_RETRYABLE');
  assert.strictEqual(dlqMsg.properties.headers['x-error-message'], 'Invalid payload: missing template ID');
  console.log(`   ✅ Non-retryable error routed to DLQ with diagnostic headers: ${JSON.stringify(dlqMsg.properties.headers)}.\n`);

  // -------------------------------------------------------------------------
  // Test 4: Retries Exhaustion -> Routing to DLQ
  // -------------------------------------------------------------------------
  console.log('▶️ [Test 4] Retries Exhaustion -> Route to DLQ...');
  const { jobId: job4 } = await createTestJob({
    shouldFail: true,
    errorType: 'RETRYABLE',
    errorMessage: 'Persistent 504 Gateway Timeout',
  }, 2);

  // Set retry_count = 2 (reaching max_retries = 2)
  await testDb.query('UPDATE jobs SET retry_count = 2 WHERE id = $1', [job4]);

  const msg4: JobQueueMessage = {
    jobId: job4,
    type: 'PDF_GENERATION',
    timestamp: new Date().toISOString(),
  };

  const res4 = await processJob(msg4);
  assert.strictEqual(res4.action, 'DLQ', 'Exhausted retry must return action DLQ');
  if (res4.action === 'DLQ') {
    assert.strictEqual(res4.reason, 'MAX_RETRIES_EXHAUSTED');
    assert.strictEqual(res4.retryCount, 2);
    await publishToDLQ(ch, msg4, { reason: res4.reason, error: res4.error, retryCount: res4.retryCount });
  }

  const dbJob4 = await workerDb.findJobById(job4);
  assert.strictEqual(dbJob4?.status, 'FAILED');

  const dlqMsg4 = await ch.get(FORGEFLOW_DLQ_QUEUE, { noAck: true });
  assert.ok(dlqMsg4, 'DLQ message for exhausted job must exist');
  assert.strictEqual(dlqMsg4.properties.headers['x-rejection-reason'], 'MAX_RETRIES_EXHAUSTED');
  assert.strictEqual(dlqMsg4.properties.headers['x-retry-count'], 2);
  console.log(`   ✅ Retries exhaustion routed to DLQ with header x-rejection-reason: MAX_RETRIES_EXHAUSTED.\n`);

  // -------------------------------------------------------------------------
  // Test 5: Poison Message -> Isolated in DLQ
  // -------------------------------------------------------------------------
  console.log('▶️ [Test 5] Poison / Unparseable Message Isolation in DLQ...');
  const poisonPayload = Buffer.from('NOT_VALID_JSON_{{corrupted}}');
  await publishToDLQ(ch, poisonPayload, {
    reason: 'POISON_UNPARSEABLE_MESSAGE',
    error: 'Unexpected token in JSON',
  });

  const dlqPoison = await ch.get(FORGEFLOW_DLQ_QUEUE, { noAck: true });
  assert.ok(dlqPoison, 'Poison message must be stored in DLQ');
  assert.strictEqual(dlqPoison.properties.headers['x-rejection-reason'], 'POISON_UNPARSEABLE_MESSAGE');
  assert.strictEqual(dlqPoison.content.toString(), 'NOT_VALID_JSON_{{corrupted}}');
  console.log('   ✅ Corrupted poison message safely captured in DLQ without stalling workers.\n');

  // Clean up
  await ch.close();
  await conn.close();

  console.log('====================================================');
  console.log('🎉 ALL RABBITMQ RETRY & DLQ TESTS PASSED!');
  console.log('====================================================');
}

runRabbitMQRetryAndDlqTests()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('\n❌ RabbitMQ Retry & DLQ Tests Failed:', err);
    await pool.end();
    process.exit(1);
  });
