import assert from 'node:assert';
import {
  calculateRetryDelay,
  calculateNextRetryAt,
  classifyError,
  RetryableError,
  NonRetryableError,
  NetworkTimeoutError,
  InvalidPayloadError,
  DEFAULT_BASE_DELAY_MS,
  DEFAULT_MAX_DELAY_MS,
} from '../src/retry';

async function runRetryUnitTests() {
  console.log('====================================================');
  console.log('🧪 ForgeFlow Phase 6.1: Retry Policy Unit Tests');
  console.log('====================================================\n');

  // Test C: Exponential Backoff (deterministic with jitterType: 'none')
  console.log('▶️ [Test C] Verifying Exponential Backoff (without jitter)...');
  const d0 = calculateRetryDelay(0, { jitterType: 'none', baseDelayMs: 2000, maxDelayMs: 60000 });
  const d1 = calculateRetryDelay(1, { jitterType: 'none', baseDelayMs: 2000, maxDelayMs: 60000 });
  const d2 = calculateRetryDelay(2, { jitterType: 'none', baseDelayMs: 2000, maxDelayMs: 60000 });
  const d3 = calculateRetryDelay(3, { jitterType: 'none', baseDelayMs: 2000, maxDelayMs: 60000 });
  const d6 = calculateRetryDelay(6, { jitterType: 'none', baseDelayMs: 2000, maxDelayMs: 60000 });

  assert.strictEqual(d0, 2000, 'Retry #0 raw delay must be 2000ms (2s * 2^0)');
  assert.strictEqual(d1, 4000, 'Retry #1 raw delay must be 4000ms (2s * 2^1)');
  assert.strictEqual(d2, 8000, 'Retry #2 raw delay must be 8000ms (2s * 2^2)');
  assert.strictEqual(d3, 16000, 'Retry #3 raw delay must be 16000ms (2s * 2^3)');
  assert.strictEqual(d6, 60000, 'Retry #6 must be capped at maxDelayMs (60000ms)');
  console.log(`   ✅ Exponential growth verified: [${d0}ms, ${d1}ms, ${d2}ms, ${d3}ms, cap: ${d6}ms]\n`);

  // Test D: Jitter Bounds Verification
  console.log('▶️ [Test D] Verifying Jitter Bounds...');
  // Test Equal Jitter (delay should be in [0.5 * raw, raw])
  const minJitter = calculateRetryDelay(1, { jitterType: 'equal', baseDelayMs: 2000, randomFn: () => 0.0 });
  const midJitter = calculateRetryDelay(1, { jitterType: 'equal', baseDelayMs: 2000, randomFn: () => 0.5 });
  const maxJitter = calculateRetryDelay(1, { jitterType: 'equal', baseDelayMs: 2000, randomFn: () => 1.0 });

  assert.strictEqual(minJitter, 2000, 'Equal jitter at random=0 must be 50% of 4000ms = 2000ms');
  assert.strictEqual(midJitter, 3000, 'Equal jitter at random=0.5 must be 75% of 4000ms = 3000ms');
  assert.strictEqual(maxJitter, 4000, 'Equal jitter at random=1.0 must be 100% of 4000ms = 4000ms');

  // Verify multiple random iterations stay strictly within bounds
  for (let i = 0; i < 50; i++) {
    const delay = calculateRetryDelay(2, { jitterType: 'equal', baseDelayMs: 2000 });
    assert.ok(delay >= 4000 && delay <= 8000, `Jittered delay (${delay}ms) must stay within [4000, 8000]`);
  }
  console.log('   ✅ Equal jitter bounds [0.5 * D, D] mathematically verified.\n');

  // Test: Error Classification
  console.log('▶️ [Classification] Verifying Error Classification Abstraction...');
  assert.strictEqual(classifyError(new NetworkTimeoutError('Network timeout')), 'RETRYABLE');
  assert.strictEqual(classifyError(new InvalidPayloadError('Invalid schema')), 'NON_RETRYABLE');

  const genericNetworkErr = new Error('getaddrinfo ENOTFOUND api.service.internal');
  (genericNetworkErr as any).code = 'ENOTFOUND';
  assert.strictEqual(classifyError(genericNetworkErr), 'RETRYABLE');

  const connectionResetErr = new Error('read ECONNRESET');
  assert.strictEqual(classifyError(connectionResetErr), 'RETRYABLE');

  const validationErr = new Error('Validation failed: field "email" is required');
  assert.strictEqual(classifyError(validationErr), 'NON_RETRYABLE');

  const unsupportedTypeErr = new Error('Unsupported job type: UNKNOWN_TASK');
  assert.strictEqual(classifyError(unsupportedTypeErr), 'NON_RETRYABLE');

  console.log('   ✅ Explicit error classification correctly identifies RETRYABLE vs NON_RETRYABLE.\n');

  console.log('====================================================');
  console.log('🎉 ALL RETRY UNIT TESTS PASSED!');
  console.log('====================================================');
}

runRetryUnitTests().catch((err) => {
  console.error('\n❌ Unit Tests Failed:', err);
  process.exit(1);
});
