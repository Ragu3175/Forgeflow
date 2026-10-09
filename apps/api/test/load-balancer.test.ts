import assert from 'node:assert';
import { execSync } from 'node:child_process';
import { pool } from '../src/db';

const NGINX_URL = process.env.API_URL || 'http://localhost:4000';

interface ApiResponse<T = any> {
  status: number;
  data: T;
  headers: Headers;
  instance: string | null;
  loadBalancer: string | null;
}

async function request<T = any>(
  endpoint: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: any;
  } = {}
): Promise<ApiResponse<T>> {
  const url = endpoint.startsWith('http') ? endpoint : `${NGINX_URL}${endpoint}`;
  const res = await fetch(url, {
    method: options.method || 'GET',
    headers: options.headers || {},
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const contentType = res.headers.get('content-type') || '';
  let data: any;
  if (contentType.includes('application/json')) {
    data = await res.json();
  } else {
    data = await res.text();
  }

  return {
    status: res.status,
    data,
    headers: res.headers,
    instance: res.headers.get('x-forgeflow-instance'),
    loadBalancer: res.headers.get('x-load-balancer'),
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runLoadBalancerTestSuite() {
  console.log('====================================================');
  console.log('🧪 ForgeFlow Phase 8: Load Balancing Test Suite');
  console.log('====================================================\n');

  // -------------------------------------------------------------------------
  // Test 1: Nginx Reachability & Health Endpoints
  // -------------------------------------------------------------------------
  console.log('▶️ [Test 1] Verifying Nginx & API Health Endpoints...');
  const healthRes = await request('/health');
  assert.strictEqual(healthRes.status, 200, 'Health endpoint must return HTTP 200');
  assert.strictEqual(healthRes.data.status, 'ok');
  assert.strictEqual(healthRes.loadBalancer, 'forgeflow-nginx');
  assert.ok(healthRes.instance === 'api-1' || healthRes.instance === 'api-2');
  console.log(`   ✅ /health reachable via Nginx (Handled by instance: ${healthRes.instance})`);

  const readyRes = await request('/ready');
  assert.strictEqual(readyRes.status, 200, 'Readiness endpoint must return HTTP 200');
  assert.strictEqual(readyRes.data.status, 'ready');
  assert.deepStrictEqual(readyRes.data.dependencies, {
    postgres: 'ok',
    redis: 'ok',
    rabbitmq: 'ok',
  });
  console.log(`   ✅ /ready verified all dependencies healthy: Postgres, Redis, RabbitMQ (Instance: ${readyRes.instance})\n`);

  // -------------------------------------------------------------------------
  // Test 2: Traffic Distribution across API instances (Round-Robin)
  // -------------------------------------------------------------------------
  console.log('▶️ [Test 2] Testing Request Distribution across API #1 and API #2...');
  const requestCount = 20;
  const instanceHits: Record<string, number> = { 'api-1': 0, 'api-2': 0 };

  for (let i = 0; i < requestCount; i++) {
    const res = await request('/health');
    assert.strictEqual(res.status, 200);
    const inst = res.instance || 'unknown';
    instanceHits[inst] = (instanceHits[inst] || 0) + 1;
  }

  console.log(`   Total requests sent: ${requestCount}`);
  console.log(`   Distribution results: ${JSON.stringify(instanceHits)}`);
  assert.ok(
    instanceHits['api-1'] > 0 && instanceHits['api-2'] > 0,
    'Both API instances must receive traffic through Nginx'
  );
  console.log('   ✅ Traffic successfully distributed across both API instances.\n');

  // -------------------------------------------------------------------------
  // Test 3: Stateless Authentication across Multiple Instances
  // -------------------------------------------------------------------------
  console.log('▶️ [Test 3] Verifying Stateless JWT Authentication across instances...');
  const email = `lb_test_${Date.now()}@forgeflow.test`;
  const password = 'Password123!';

  // Register user
  const regRes = await request('/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: { email, password, name: 'LB Test User' },
  });
  assert.strictEqual(regRes.status, 201);
  const token = regRes.data.token;
  const registeredBy = regRes.instance;
  console.log(`   User registered on instance: ${registeredBy}`);

  // Send multiple authenticated /auth/me requests to verify both instances can authenticate the JWT
  const authInstanceHits: Record<string, number> = {};
  for (let i = 0; i < 10; i++) {
    const meRes = await request('/auth/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(meRes.status, 200);
    assert.strictEqual(meRes.data.email, email);
    const inst = meRes.instance || 'unknown';
    authInstanceHits[inst] = (authInstanceHits[inst] || 0) + 1;
  }

  console.log(`   Authenticated /auth/me distribution: ${JSON.stringify(authInstanceHits)}`);
  assert.ok(
    authInstanceHits['api-1'] > 0 && authInstanceHits['api-2'] > 0,
    'Both API instances must successfully validate the stateless JWT token'
  );
  console.log('   ✅ Stateless JWT authentication verified on both API instances.\n');

  // -------------------------------------------------------------------------
  // Test 4: End-to-End Job Creation & Outbox Processing through Load Balancer
  // -------------------------------------------------------------------------
  console.log('▶️ [Test 4] Real Job Processing: Nginx -> API -> Outbox -> RabbitMQ -> Worker...');
  const createJobRes = await request('/jobs', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'Idempotency-Key': `key-lb-job-${Date.now()}`,
    },
    body: {
      type: 'PDF_GENERATION',
      payload: { documentId: 'LB-DOC-001', test: 'local-load-balancing' },
    },
  });

  assert.strictEqual(createJobRes.status, 201);
  const jobId = createJobRes.data.id;
  assert.ok(jobId, 'Job ID should be returned');
  console.log(`   Job created on instance: ${createJobRes.instance} (Job ID: ${jobId})`);

  // Poll job status until COMPLETED
  let finalJob: any = null;
  for (let attempt = 0; attempt < 25; attempt++) {
    await sleep(500);
    const getJobRes = await request(`/jobs/${jobId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (getJobRes.status === 200 && (getJobRes.data.status === 'COMPLETED' || getJobRes.data.status === 'FAILED')) {
      finalJob = getJobRes.data;
      break;
    }
  }

  assert.ok(finalJob, 'Job must finish processing within polling window');
  assert.strictEqual(finalJob.status, 'COMPLETED', 'Job must reach COMPLETED status');
  console.log(`   ✅ End-to-End job completed successfully (Final status: ${finalJob.status}).\n`);

  // -------------------------------------------------------------------------
  // Test 5: API Idempotency across Multi-Instance Load Balancer
  // -------------------------------------------------------------------------
  console.log('▶️ [Test 5] Multi-Instance Idempotency via Nginx...');
  const sharedKey = `shared-idempotency-key-${Date.now()}`;

  // First request
  const firstIdempotentRes = await request('/jobs', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'Idempotency-Key': sharedKey,
    },
    body: {
      type: 'AI_SUMMARY',
      payload: { text: 'Testing idempotency across load balanced nodes' },
    },
  });
  assert.strictEqual(firstIdempotentRes.status, 201);
  const createdJobId = firstIdempotentRes.data.id;
  const firstInstance = firstIdempotentRes.instance;

  // Replay request 10 times through Nginx (will hit both api1 and api2)
  const replayInstances: Record<string, number> = {};
  for (let i = 0; i < 10; i++) {
    const replayRes = await request('/jobs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': sharedKey,
      },
      body: {
        type: 'AI_SUMMARY',
        payload: { text: 'Testing idempotency across load balanced nodes' },
      },
    });

    assert.strictEqual(replayRes.status === 200 || replayRes.status === 201, true);
    assert.strictEqual(replayRes.data.id, createdJobId, 'Replayed request must return the exact same job ID');
    assert.strictEqual(replayRes.headers.get('idempotent-replayed'), 'true');
    const inst = replayRes.instance || 'unknown';
    replayInstances[inst] = (replayInstances[inst] || 0) + 1;
  }

  console.log(`   Initial create handled by: ${firstInstance}`);
  console.log(`   Replays handled across instances: ${JSON.stringify(replayInstances)}`);
  assert.ok(
    replayInstances['api-1'] > 0 && replayInstances['api-2'] > 0,
    'Replays should hit both API instances'
  );
  console.log('   ✅ API Idempotency safely preserved across multiple API instances.\n');

  // -------------------------------------------------------------------------
  // Test 6: API Instance Failure & Failover Experiment
  // -------------------------------------------------------------------------
  console.log('▶️ [Test 6] Failure Isolation & Recovery Experiment...');
  console.log('   1. Stopping forgeflow-api1 container...');
  execSync('docker compose stop api1', { stdio: 'pipe' });
  await sleep(1000);
  console.log('   Container api1 stopped.');

  // Verify requests still succeed through Nginx (Nginx failover to api2)
  console.log('   2. Sending 10 requests while api1 is DOWN...');
  for (let i = 0; i < 10; i++) {
    const res = await request('/health');
    assert.strictEqual(res.status, 200, 'Requests must succeed even with api1 down');
    assert.strictEqual(res.instance, 'api-2', 'Traffic must seamlessly failover to api-2');
  }
  console.log('   ✅ 100% of requests successfully handled by api-2 while api1 is down.');


  console.log('   3. Restarting forgeflow-api1 container...');
  execSync('docker compose start api1', { stdio: 'pipe' });
  console.log('   Container api1 restarted.');

  // Wait for api1 to become healthy and rejoin Nginx pool
  console.log('   4. Waiting for api1 to become healthy and rejoin upstream pool...');
  let rejoined = false;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const res = await request('/health');
    if (res.instance === 'api-1') {
      rejoined = true;
      break;
    }
  }
  assert.ok(rejoined, 'api1 must successfully rejoin the load balancer pool after recovery');
  console.log('   ✅ api1 successfully rejoined the active upstream pool.\n');

  console.log('====================================================');
  console.log('🎉 ALL LOAD BALANCING TESTS PASSED SUCCESSFULLY!');
  console.log('====================================================\n');
}

runLoadBalancerTestSuite()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('\n❌ Load Balancer Tests Failed:', err);
    await pool.end();
    process.exit(1);
  });
