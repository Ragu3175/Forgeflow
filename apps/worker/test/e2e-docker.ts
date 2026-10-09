import assert from 'node:assert';
import amqp, { Channel, ChannelModel } from 'amqplib';
import {
  FORGEFLOW_JOBS_QUEUE,
  FORGEFLOW_RETRY_QUEUE,
  FORGEFLOW_DLQ_QUEUE,
} from '@forgeflow/shared';

const API_BASE = 'http://localhost:4000';
const RABBITMQ_URL = 'amqp://guest:guest@localhost:5672';

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runE2ETests() {
  console.log('====================================================');
  console.log('🌐 ForgeFlow Phase 6.2: Docker Compose E2E Test Suite');
  console.log('====================================================\n');

  // 1. Healthcheck
  console.log('▶️ [1] Verifying API Health...');
  const healthRes = await fetch(`${API_BASE}/health`);
  const healthJson = (await healthRes.json()) as any;
  assert.strictEqual(healthRes.status, 200);
  assert.strictEqual(healthJson.status, 'ok');
  console.log('   ✅ API is healthy.\n');

  // 2. Authentication
  console.log('▶️ [2] Registering E2E test user...');
  const email = `e2e_${Date.now()}@forgeflow.test`;
  const regRes = await fetch(`${API_BASE}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password: 'password123',
      name: 'Phase 6.2 E2E User',
    }),
  });
  const regJson = (await regRes.json()) as any;
  assert.strictEqual(regRes.status, 201);
  const token = regJson.token;
  assert.ok(token, 'JWT token returned');
  console.log(`   ✅ Registered user: ${email}\n`);

  const authHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };

  // 3. Connect to RabbitMQ for queue inspection
  console.log('▶️ [3] Connecting to RabbitMQ for queue state inspection...');
  const conn: ChannelModel = await amqp.connect(RABBITMQ_URL);
  const ch: Channel = await conn.createChannel();
  console.log('   ✅ RabbitMQ AMQP connection established.\n');

  // Purge DLQ to start clean
  await ch.purgeQueue(FORGEFLOW_DLQ_QUEUE);

  // -------------------------------------------------------------------------
  // E2E Test 1: Successful Job Lifecycle + API Idempotency
  // -------------------------------------------------------------------------
  console.log('▶️ [E2E Test 1] Successful Job & API Idempotency...');
  const idempotencyKey = `e2e-key-${Date.now()}`;
  const createRes = await fetch(`${API_BASE}/jobs`, {
    method: 'POST',
    headers: {
      ...authHeaders,
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({
      type: 'PDF_GENERATION',
      payload: { shouldFail: false, documentTitle: 'E2E Report' },
    }),
  });
  const createJson = (await createRes.json()) as any;
  assert.strictEqual(createRes.status, 201);
  const jobId1 = createJson.id;
  assert.strictEqual(createJson.status, 'PENDING');
  console.log(`   ✅ Job created: ${jobId1}`);

  // Replay same Idempotency-Key
  const replayRes = await fetch(`${API_BASE}/jobs`, {
    method: 'POST',
    headers: {
      ...authHeaders,
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({
      type: 'PDF_GENERATION',
      payload: { shouldFail: false },
    }),
  });
  const replayJson = (await replayRes.json()) as any;
  assert.strictEqual(replayRes.status, 200);
  assert.strictEqual(replayRes.headers.get('idempotent-replayed'), 'true');
  assert.strictEqual(replayJson.id, jobId1);
  console.log('   ✅ Duplicate POST safely replayed exact same job.');

  // Wait for worker container to process the job (simulated workload 2.5s)
  console.log('   Waiting for worker container to complete job...');
  let job1Status = 'PENDING';
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    const getRes = await fetch(`${API_BASE}/jobs/${jobId1}`, { headers: authHeaders });
    const getJson = (await getRes.json()) as any;
    job1Status = getJson.status;
    if (job1Status === 'COMPLETED') break;
  }
  assert.strictEqual(job1Status, 'COMPLETED', 'Job must reach COMPLETED status');
  console.log('   ✅ Job 1 reached COMPLETED status in Docker worker container.\n');

  // -------------------------------------------------------------------------
  // E2E Test 2: Retryable Error -> Delayed Retry Routing
  // -------------------------------------------------------------------------
  console.log('▶️ [E2E Test 2] Retryable Error -> Delay routing with exponential backoff...');
  const retryKey = `e2e-retry-${Date.now()}`;
  const retryCreateRes = await fetch(`${API_BASE}/jobs`, {
    method: 'POST',
    headers: {
      ...authHeaders,
      'Idempotency-Key': retryKey,
    },
    body: JSON.stringify({
      type: 'PDF_GENERATION',
      payload: {
        shouldFail: true,
        errorType: 'RETRYABLE',
        errorMessage: 'Simulated 503 Service Unavailable',
      },
    }),
  });
  const retryCreateJson = (await retryCreateRes.json()) as any;
  const retryJobId = retryCreateJson.id;
  console.log(`   Job created: ${retryJobId}`);

  // Wait for worker to fail attempt 1 and schedule retry
  console.log('   Waiting for worker container to process attempt 1...');
  let jobStateAfterAttempt: any = null;
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    const getRetryRes = await fetch(`${API_BASE}/jobs/${retryJobId}`, { headers: authHeaders });
    const getRetryJson = (await getRetryRes.json()) as any;
    if (getRetryJson?.retryCount >= 1) {
      jobStateAfterAttempt = getRetryJson;
      break;
    }
  }

  assert.ok(jobStateAfterAttempt, 'Job must have completed attempt 1');
  console.log(`   Job status: ${jobStateAfterAttempt.status}`);
  console.log(`   Retry count: ${jobStateAfterAttempt.retryCount}`);
  console.log(`   Last error: ${jobStateAfterAttempt.lastError}`);
  console.log(`   Next retry at: ${jobStateAfterAttempt.nextRetryAt}`);

  assert.ok(jobStateAfterAttempt.retryCount >= 1, 'retryCount must be at least 1');
  assert.ok(jobStateAfterAttempt.lastError?.includes('503 Service Unavailable'));
  assert.ok(jobStateAfterAttempt.nextRetryAt !== null);
  console.log('   ✅ Retryable failure recorded durable state and routed through delay queue.\n');

  // -------------------------------------------------------------------------
  // E2E Test 3: Non-Retryable Error -> Direct DLQ Routing
  // -------------------------------------------------------------------------
  console.log('▶️ [E2E Test 3] Non-Retryable Error -> Direct DLQ routing...');
  const nonRetryKey = `e2e-nonretry-${Date.now()}`;
  const nonRetryRes = await fetch(`${API_BASE}/jobs`, {
    method: 'POST',
    headers: {
      ...authHeaders,
      'Idempotency-Key': nonRetryKey,
    },
    body: JSON.stringify({
      type: 'PDF_GENERATION',
      payload: {
        shouldFail: true,
        errorType: 'NON_RETRYABLE',
        errorMessage: 'Invalid payload: schema validation failed',
      },
    }),
  });
  const nonRetryJson = (await nonRetryRes.json()) as any;
  const nonRetryJobId = nonRetryJson.id;

  // Wait for worker to process and route to DLQ
  console.log('   Waiting for worker container to process non-retryable job...');
  let nonRetryState: any = null;
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    const getNonRetryRes = await fetch(`${API_BASE}/jobs/${nonRetryJobId}`, { headers: authHeaders });
    const getNonRetryJson = (await getNonRetryRes.json()) as any;
    if (getNonRetryJson?.status === 'FAILED') {
      nonRetryState = getNonRetryJson;
      break;
    }
  }

  assert.ok(nonRetryState, 'Non-retryable job must reach FAILED status');
  assert.strictEqual(nonRetryState.status, 'FAILED');
  assert.strictEqual(nonRetryState.retryCount, 0, 'retryCount must remain 0');
  console.log(`   ✅ Non-retryable job status: ${nonRetryState.status} (retryCount: ${nonRetryState.retryCount})`);

  // Check message in DLQ
  const dlqMsg = await ch.get(FORGEFLOW_DLQ_QUEUE, { noAck: true });
  assert.ok(dlqMsg, 'DLQ must receive the rejected message');
  const dlqPayload = JSON.parse(dlqMsg.content.toString());
  assert.strictEqual(dlqPayload.jobId, nonRetryJobId);
  assert.strictEqual(dlqMsg.properties.headers['x-rejection-reason'], 'NON_RETRYABLE');
  console.log(`   ✅ Message confirmed in '${FORGEFLOW_DLQ_QUEUE}' with header x-rejection-reason: NON_RETRYABLE.\n`);

  // -------------------------------------------------------------------------
  // E2E Test 4: Poison / Corrupted Message Isolation in DLQ
  // -------------------------------------------------------------------------
  console.log('▶️ [E2E Test 4] Poison Message Isolation in DLQ...');
  const poisonPayload = Buffer.from('MALFORMED_CORRUPT_JSON_{{bad_data}}');
  ch.sendToQueue(FORGEFLOW_JOBS_QUEUE, poisonPayload, { persistent: true });

  // Wait for worker container to catch poison message
  await sleep(2000);

  const poisonDlq = await ch.get(FORGEFLOW_DLQ_QUEUE, { noAck: true });
  assert.ok(poisonDlq, 'Poison message must be forwarded to DLQ');
  assert.strictEqual(poisonDlq.properties.headers['x-rejection-reason'], 'POISON_UNPARSEABLE_MESSAGE');
  assert.strictEqual(poisonDlq.content.toString(), 'MALFORMED_CORRUPT_JSON_{{bad_data}}');
  console.log('   ✅ Poison message safely routed to DLQ without crashing worker.\n');

  // Cleanup
  await ch.close();
  await conn.close();

  console.log('====================================================');
  console.log('🎉 ALL DOCKER COMPOSE E2E TESTS PASSED SUCCESSFULLY!');
  console.log('====================================================');
}

runE2ETests().catch((err) => {
  console.error('\n❌ Docker Compose E2E Test Failed:', err);
  process.exit(1);
});
