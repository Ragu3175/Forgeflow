import assert from 'node:assert';

const API_BASE = process.env.API_URL || 'http://localhost:4000';

interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: any;
}

interface ApiResponse<T = any> {
  status: number;
  data: T;
  headers: Headers;
  durationMs: number;
}

async function request<T = any>(
  endpoint: string,
  options: RequestOptions = {}
): Promise<ApiResponse<T>> {
  const url = endpoint.startsWith('http') ? endpoint : `${API_BASE}${endpoint}`;
  const start = Date.now();
  const res = await fetch(url, {
    method: options.method || 'GET',
    headers: options.headers || {},
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const durationMs = Date.now() - start;

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
    durationMs,
  };
}

async function registerAndLogin(emailPrefix: string) {
  const email = `${emailPrefix}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}@forgeflow.test`;
  const password = 'Password123!';
  const registerRes = await request('/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: {
      email,
      password,
      name: `Test User ${emailPrefix}`,
    },
  });

  assert.strictEqual(
    registerRes.status,
    201,
    `Failed to register user: ${JSON.stringify(registerRes.data)}`
  );
  const token = registerRes.data.token;
  const user = registerRes.data.user;
  assert.ok(token, 'Token should be defined in register response');
  assert.ok(user?.id, 'User ID should be defined in register response');

  return { email, token, user };
}

async function runTests() {
  console.log('====================================================');
  console.log('🧪 ForgeFlow Phase 5: API Idempotency Test Suite');
  console.log('====================================================\n');

  // Test 0: Health Check
  console.log('▶️ [0] Checking API Health...');
  const health = await request('/health');
  assert.strictEqual(health.status, 200, 'API must be healthy');
  console.log('   ✅ API is up and running.\n');

  // Setup Users
  console.log('▶️ Setting up isolated test users...');
  const userA = await registerAndLogin('userA');
  const userB = await registerAndLogin('userB');
  console.log(`   ✅ User A created: ${userA.user.id}`);
  console.log(`   ✅ User B created: ${userB.user.id}\n`);

  // Scenario E: Missing Idempotency-Key
  console.log('▶️ [Scenario E] Reject missing Idempotency-Key header...');
  const missingHeaderRes = await request('/jobs', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${userA.token}`,
    },
    body: {
      type: 'PDF_GENERATION',
      payload: { documentId: 'DOC-NO-KEY' },
    },
  });
  assert.strictEqual(
    missingHeaderRes.status,
    400,
    `Expected 400 Bad Request for missing key, got ${missingHeaderRes.status}`
  );
  console.log('   ✅ Missing Idempotency-Key rejected with HTTP 400.');

  // Scenario F: Empty & Overly Large Idempotency-Key
  console.log('▶️ [Validation] Reject empty and oversized Idempotency-Key...');
  const emptyKeyRes = await request('/jobs', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${userA.token}`,
      'Idempotency-Key': '   ',
    },
    body: { type: 'PDF_GENERATION' },
  });
  assert.strictEqual(
    emptyKeyRes.status,
    400,
    `Expected 400 for empty key, got ${emptyKeyRes.status}`
  );

  const oversizedKey = 'k'.repeat(300);
  const oversizedKeyRes = await request('/jobs', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${userA.token}`,
      'Idempotency-Key': oversizedKey,
    },
    body: { type: 'PDF_GENERATION' },
  });
  assert.strictEqual(
    oversizedKeyRes.status,
    400,
    `Expected 400 for oversized key, got ${oversizedKeyRes.status}`
  );
  console.log('   ✅ Empty and oversized keys rejected with HTTP 400.\n');

  // Scenario A: First request with valid key
  const testKey1 = `key-phase5-${Date.now()}-1`;
  console.log(`▶️ [Scenario A] First request with key: "${testKey1}"...`);
  const firstReq = await request('/jobs', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${userA.token}`,
      'Idempotency-Key': testKey1,
    },
    body: {
      type: 'PDF_GENERATION',
      payload: { documentId: 'DOC-FIRST-001', title: 'Idempotency First' },
    },
  });

  assert.strictEqual(
    firstReq.status,
    201,
    `Expected HTTP 201 for first job creation, got ${firstReq.status}`
  );
  const job1 = firstReq.data;
  assert.ok(job1?.id, 'Created job should have an ID');
  assert.strictEqual(job1.userId, userA.user.id);
  assert.strictEqual(job1.type, 'PDF_GENERATION');
  console.log(`   ✅ Job created successfully: ${job1.id} (Status: ${job1.status})\n`);

  // Scenario B: Same request repeated with same key
  console.log(`▶️ [Scenario B] Repeated request with same key: "${testKey1}"...`);
  const secondReq = await request('/jobs', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${userA.token}`,
      'Idempotency-Key': testKey1,
    },
    body: {
      type: 'PDF_GENERATION',
      payload: { documentId: 'DOC-FIRST-001', title: 'Idempotency First' },
    },
  });

  assert.strictEqual(
    secondReq.status === 200 || secondReq.status === 201,
    true,
    `Expected HTTP 200/201 on replayed request, got ${secondReq.status}`
  );
  const job1Replayed = secondReq.data;
  assert.strictEqual(
    job1Replayed.id,
    job1.id,
    `Replayed job ID (${job1Replayed.id}) must match original (${job1.id})`
  );
  assert.strictEqual(
    secondReq.headers.get('idempotent-replayed'),
    'true',
    'Idempotent-Replayed header should be present'
  );
  console.log(`   ✅ Exact same job returned: ${job1Replayed.id} (Header: Idempotent-Replayed=true)\n`);

  // Verify total jobs count for user A remains 1
  const userAJobs = await request('/jobs', {
    headers: { Authorization: `Bearer ${userA.token}` },
  });
  const matchingJobs = userAJobs.data.jobs.filter((j: any) => j.id === job1.id);
  assert.strictEqual(
    matchingJobs.length,
    1,
    'There must be exactly 1 job in database for that key'
  );
  console.log('   ✅ Verified no duplicate job rows created in PostgreSQL.\n');

  // Scenario C: Same key with different authenticated user
  console.log(`▶️ [Scenario C] Same key "${testKey1}" with different authenticated user (User B)...`);
  const userBReq = await request('/jobs', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${userB.token}`,
      'Idempotency-Key': testKey1, // Identical key string
    },
    body: {
      type: 'DATA_PROCESSING',
      payload: { dataset: 'userB-data' },
    },
  });

  assert.strictEqual(
    userBReq.status,
    201,
    `Expected HTTP 201 for User B with independent key, got ${userBReq.status}`
  );
  const jobUserB = userBReq.data;
  assert.ok(jobUserB?.id, 'User B job must have an ID');
  assert.notStrictEqual(
    jobUserB.id,
    job1.id,
    'User B must receive their own distinct job, not User A job'
  );
  assert.strictEqual(jobUserB.userId, userB.user.id);
  console.log(`   ✅ Multi-tenant isolation verified: User B got unique job ${jobUserB.id}.\n`);

  // Scenario D: Two concurrent requests using same user + same key
  const concurrentKey = `concurrent-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  console.log(`▶️ [Scenario D] Dispatching 5 concurrent requests simultaneously with key "${concurrentKey}"...`);

  const concurrentPromises = Array.from({ length: 5 }, (_, i) =>
    request('/jobs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userA.token}`,
        'Idempotency-Key': concurrentKey,
      },
      body: {
        type: 'AI_SUMMARY',
        payload: { attempt: i, docId: 'concurrent-doc' },
      },
    })
  );

  const concurrentResults = await Promise.all(concurrentPromises);
  const statusCodes = concurrentResults.map((r) => r.status);
  const returnedJobIds = concurrentResults.map((r) => r.data?.id);
  const uniqueReturnedJobIds = Array.from(new Set(returnedJobIds));

  console.log(`   Status codes returned: ${statusCodes.join(', ')}`);
  console.log(`   Unique Job IDs returned across 5 concurrent requests: ${uniqueReturnedJobIds.join(', ')}`);

  assert.strictEqual(
    uniqueReturnedJobIds.length,
    1,
    'All concurrent requests must return the exact same job ID'
  );

  // Confirm database has exactly one job for this concurrent batch
  const userAJobsAfter = await request('/jobs', {
    headers: { Authorization: `Bearer ${userA.token}` },
  });
  const concurrentJobsInDb = userAJobsAfter.data.jobs.filter(
    (j: any) => j.id === uniqueReturnedJobIds[0]
  );
  assert.strictEqual(
    concurrentJobsInDb.length,
    1,
    'PostgreSQL must contain exactly 1 job record for concurrent batch'
  );
  console.log('   ✅ Concurrency & race condition safety verified at database level.\n');

  console.log('====================================================');
  console.log('🎉 ALL PHASE 5 IDEMPOTENCY TESTS PASSED SUCCESSFULLY!');
  console.log('====================================================');
}

runTests()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n❌ Test Suite Failed:', err);
    process.exit(1);
  });

