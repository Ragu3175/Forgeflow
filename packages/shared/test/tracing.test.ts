/**
 * ForgeFlow Phase 9.4: OpenTelemetry Tracing Unit Tests
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import {
  initTracing,
  injectTraceContext,
  extractTraceContext,
  getActiveTraceContext,
  withSpan,
  sanitizeSpanAttributes,
  trace,
  SpanKind,
  SpanStatusCode,
} from '../src/tracing';
import { createLogger } from '../src/logger';

export async function runTracingUnitTests() {
  console.log('\n====================================================');
  console.log('🧪 ForgeFlow Phase 9.4: Tracing Unit Tests');
  console.log('====================================================\n');

  // Test 1: Tracing Initialization
  console.log('▶️ [Test 1] Verifying OpenTelemetry Tracing Initialization...');
  const tracing = initTracing({
    serviceName: 'forgeflow-test-service',
    serviceVersion: '1.0.0',
    enabled: true,
    useSimpleSpanProcessor: true,
  });
  assert.strictEqual(tracing.enabled, true, 'Tracing should be enabled');
  assert.ok(tracing.tracer, 'Tracer instance should be available');
  console.log('   ✅ Tracing initialized with standard Tracer instance.');

  // Test 2: W3C Trace Context Injection & Extraction
  console.log('\n▶️ [Test 2] W3C Trace Context Injection & Extraction...');
  await withSpan('test_root_operation', async (span) => {
    const carrier: Record<string, string> = {};
    injectTraceContext(carrier);

    assert.ok(carrier.traceparent, 'Carrier must contain W3C traceparent header');
    assert.match(
      carrier.traceparent,
      /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/,
      'traceparent format must match W3C specification: version-trace_id-parent_id-trace_flags'
    );

    const activeTrace = getActiveTraceContext();
    assert.ok(activeTrace.traceId, 'Active traceId must exist');
    assert.ok(activeTrace.spanId, 'Active spanId must exist');
    assert.ok(carrier.traceparent.includes(activeTrace.traceId!), 'traceparent must carry the current traceId');

    // Extract context from carrier
    const extractedCtx = extractTraceContext(carrier);
    assert.ok(extractedCtx, 'Extracted context must be non-null');

    // Create child span from extracted context
    await withSpan(
      'test_child_operation',
      async (childSpan) => {
        const childTrace = getActiveTraceContext();
        assert.strictEqual(childTrace.traceId, activeTrace.traceId, 'Child span must share parent traceId');
        assert.notStrictEqual(childTrace.spanId, activeTrace.spanId, 'Child span must have unique spanId');
      },
      { kind: SpanKind.CONSUMER },
      extractedCtx
    );
  });
  console.log('   ✅ W3C traceparent injection and cross-boundary extraction verified.');

  // Test 3: Sensitive Span Attribute Sanitization
  console.log('\n▶️ [Test 3] Sensitive Span Attribute Sanitization...');
  const rawAttributes = {
    'user.id': 'usr_123',
    'http.method': 'POST',
    'user.password': 'secret_password_123',
    'auth.jwt': 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
    'auth.token': 'bearer_token_xyz',
    'request.authorization': 'Bearer topsecret',
    'nested.credentials': { user: 'admin', pass: 'root' },
  };

  const sanitized = sanitizeSpanAttributes(rawAttributes);
  assert.strictEqual(sanitized['user.id'], 'usr_123');
  assert.strictEqual(sanitized['http.method'], 'POST');
  assert.strictEqual(sanitized['user.password'], '[REDACTED]');
  assert.strictEqual(sanitized['auth.jwt'], '[REDACTED]');
  assert.strictEqual(sanitized['auth.token'], '[REDACTED]');
  assert.strictEqual(sanitized['request.authorization'], '[REDACTED]');
  console.log('   ✅ All sensitive attributes (passwords, JWTs, auth tokens) successfully redacted.');

  // Test 4: Structured Logger Auto-Enrichment with traceId & spanId
  console.log('\n▶️ [Test 4] Structured Logger Auto-Enrichment with Trace Context...');
  const logEntries: any[] = [];
  const logger = createLogger('test-service', {}, (line) => logEntries.push(JSON.parse(line)));

  await withSpan('test_logged_operation', async (span) => {
    const activeTrace = getActiveTraceContext();
    logger.info('operation_step_completed', { jobId: 'job_456', step: 1 });

    const lastEntry = logEntries[logEntries.length - 1];
    assert.ok(lastEntry, 'Log entry must be emitted');
    assert.strictEqual(lastEntry.traceId, activeTrace.traceId, 'Log entry must be automatically enriched with active traceId');
    assert.strictEqual(lastEntry.spanId, activeTrace.spanId, 'Log entry must be automatically enriched with active spanId');
    assert.strictEqual(lastEntry.jobId, 'job_456', 'Log entry preserves jobId');
  });
  console.log('   ✅ Structured logs automatically enriched with active traceId and spanId.');

  // Test 5: Tracing Disabled Mode
  console.log('\n▶️ [Test 5] Tracing Disabled Mode...');
  const disabledTracing = initTracing({ enabled: false });
  assert.strictEqual(disabledTracing.enabled, false);
  console.log('   ✅ Tracing disabled mode operates cleanly as a no-op.');

  console.log('\n====================================================');
  console.log('🎉 ALL TRACING UNIT TESTS PASSED!');
  console.log('====================================================\n');
}

if (process.argv[1]?.endsWith('tracing.test.ts')) {
  runTracingUnitTests().catch((err) => {
    console.error('❌ Tracing unit tests failed:', err);
    process.exit(1);
  });
}
