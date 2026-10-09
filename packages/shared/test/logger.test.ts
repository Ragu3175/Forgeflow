import assert from 'node:assert';
import { createLogger, sanitizeLogData, StructuredLogEntry } from '../src/logger';

async function runLoggerTests() {
  console.log('====================================================');
  console.log('🧪 ForgeFlow Phase 9.1: Shared Logger Unit Tests');
  console.log('====================================================\n');

  // Test 1: JSON serialization and standard fields
  console.log('▶️ [Test 1] Standard JSON format and required fields...');
  const logs: StructuredLogEntry[] = [];
  const logger = createLogger(
    'test-service',
    { instanceId: 'api-test-1' },
    (line) => logs.push(JSON.parse(line))
  );

  logger.info('test_event', {
    requestId: 'req-123',
    jobId: 'job-456',
    durationMs: 42,
    customField: 'custom-value',
  });

  assert.strictEqual(logs.length, 1);
  const entry = logs[0];
  assert.strictEqual(entry.service, 'test-service');
  assert.strictEqual(entry.level, 'info');
  assert.strictEqual(entry.event, 'test_event');
  assert.strictEqual(entry.instanceId, 'api-test-1');
  assert.strictEqual(entry.requestId, 'req-123');
  assert.strictEqual(entry.jobId, 'job-456');
  assert.strictEqual(entry.durationMs, 42);
  assert.strictEqual(entry.customField, 'custom-value');
  assert.ok(entry.timestamp, 'Timestamp must be present');
  console.log('   ✅ Structured log entry correctly formatted.\n');

  // Test 2: Child logger context binding
  console.log('▶️ [Test 2] Child logger context inheritance...');
  const childLogger = logger.child({
    requestId: 'req-child-789',
    jobId: 'job-child-999',
  });

  childLogger.warn('child_event', { extraData: 'foo' });
  assert.strictEqual(logs.length, 2);
  const childEntry = logs[1];
  assert.strictEqual(childEntry.service, 'test-service');
  assert.strictEqual(childEntry.level, 'warn');
  assert.strictEqual(childEntry.event, 'child_event');
  assert.strictEqual(childEntry.instanceId, 'api-test-1');
  assert.strictEqual(childEntry.requestId, 'req-child-789');
  assert.strictEqual(childEntry.jobId, 'job-child-999');
  assert.strictEqual(childEntry.extraData, 'foo');
  console.log('   ✅ Child logger correctly inherits and merges context.\n');

  // Test 3: Sensitive data redaction
  console.log('▶️ [Test 3] Sensitive data redaction...');
  logger.info('auth_login_attempt', {
    email: 'user@example.com',
    password: 'SuperSecretPassword123!',
    jwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.doNotLeakThisSignature',
    token: 'very-long-secret-auth-token-1234567890',
    credentials: {
      dbPassword: 'postgres_password',
      apiKey: 'api_key_secret_value',
    },
    nested: {
      userSecret: 'confidential',
      normalField: 'visible',
    },
  });

  const redactedEntry = logs[2];
  assert.strictEqual(redactedEntry.email, 'user@example.com');
  assert.strictEqual(redactedEntry.password, '[REDACTED]');
  assert.strictEqual(redactedEntry.jwt, '[REDACTED]');
  assert.strictEqual(redactedEntry.token, '[REDACTED]');
  assert.strictEqual(redactedEntry.credentials, '[REDACTED]');
  assert.strictEqual(redactedEntry.nested.userSecret, '[REDACTED]');
  assert.strictEqual(redactedEntry.nested.normalField, 'visible');
  console.log('   ✅ All sensitive fields successfully redacted.\n');

  // Test 4: Structured Error Handling
  console.log('▶️ [Test 4] Structured Error logging...');
  const errorToLog = new Error('Database connection timed out');
  (errorToLog as any).code = 'ETIMEDOUT';
  (errorToLog as any).statusCode = 504;

  logger.error('db_query_failed', { query: 'SELECT * FROM jobs' }, errorToLog);
  const errorEntry = logs[3];
  assert.strictEqual(errorEntry.level, 'error');
  assert.strictEqual(errorEntry.event, 'db_query_failed');
  assert.ok(errorEntry.error);
  assert.strictEqual(errorEntry.error.name, 'Error');
  assert.strictEqual(errorEntry.error.message, 'Database connection timed out');
  assert.strictEqual(errorEntry.error.code, 'ETIMEDOUT');
  assert.strictEqual(errorEntry.error.statusCode, 504);
  assert.ok(errorEntry.error.stack);
  console.log('   ✅ Error correctly serialized into structured error object.\n');

  console.log('====================================================');
  console.log('🎉 ALL LOGGER UNIT TESTS PASSED!');
  console.log('====================================================\n');
}

runLoggerTests().catch((err) => {
  console.error('\n❌ Logger Tests Failed:', err);
  process.exit(1);
});
