export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_BASE_DELAY_MS = 2000; // 2 seconds
export const DEFAULT_MAX_DELAY_MS = 60000; // 60 seconds

export interface RetryPolicyOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxRetries?: number;
  jitterType?: 'none' | 'full' | 'equal';
  randomFn?: () => number;
}

/**
 * Calculates exponential backoff delay with optional jitter.
 * Formula:
 *   rawDelay = min(baseDelay * 2^retryCount, maxDelay)
 * 
 * Jitter Types:
 *   - 'none': exact rawDelay (deterministic)
 *   - 'full': random * rawDelay (between 0 and rawDelay)
 *   - 'equal': (rawDelay / 2) + random * (rawDelay / 2) (between 0.5 * rawDelay and rawDelay)
 */
export function calculateRetryDelay(
  retryCount: number,
  options: RetryPolicyOptions = {}
): number {
  const {
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    jitterType = 'equal',
    randomFn = Math.random,
  } = options;

  if (retryCount < 0) {
    throw new Error('retryCount must be non-negative');
  }

  const rawDelay = Math.min(baseDelayMs * Math.pow(2, retryCount), maxDelayMs);

  if (jitterType === 'none') {
    return Math.round(rawDelay);
  }

  const random = Math.min(Math.max(randomFn(), 0), 1);

  if (jitterType === 'full') {
    return Math.round(random * rawDelay);
  }

  // Equal jitter (default): guarantees at least 50% of delay while distributing peaks
  const half = rawDelay / 2;
  return Math.round(half + random * half);
}

/**
 * Calculates the next Date timestamp at which a retry should be attempted.
 */
export function calculateNextRetryAt(
  retryCount: number,
  options: RetryPolicyOptions = {},
  now: Date = new Date()
): Date {
  const delayMs = calculateRetryDelay(retryCount, options);
  return new Date(now.getTime() + delayMs);
}

// ---------------------------------------------------------------------------
// Error Classification Abstraction
// ---------------------------------------------------------------------------

export type ErrorCategory = 'RETRYABLE' | 'NON_RETRYABLE';

export abstract class BaseJobError extends Error {
  abstract readonly isRetryable: boolean;
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class RetryableError extends BaseJobError {
  readonly isRetryable = true;
}

export class NonRetryableError extends BaseJobError {
  readonly isRetryable = false;
}

// Concrete Retryable Error Classes
export class NetworkTimeoutError extends RetryableError {}
export class ServiceUnavailableError extends RetryableError {}
export class DatabaseConnectionError extends RetryableError {}
export class RateLimitExceededError extends RetryableError {}

// Concrete Non-Retryable Error Classes
export class InvalidPayloadError extends NonRetryableError {}
export class UnsupportedJobTypeError extends NonRetryableError {}
export class ValidationError extends NonRetryableError {}
export class MissingConfigurationError extends NonRetryableError {}

/**
 * Explicitly classifies an error into RETRYABLE or NON_RETRYABLE category.
 */
export function classifyError(error: unknown): ErrorCategory {
  if (error instanceof RetryableError || (error as any)?.isRetryable === true) {
    return 'RETRYABLE';
  }

  if (error instanceof NonRetryableError || (error as any)?.isRetryable === false) {
    return 'NON_RETRYABLE';
  }

  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    const code = (error as any).code;

    // 1. Non-retryable pattern checks
    if (
      msg.includes('invalid payload') ||
      msg.includes('validation failed') ||
      msg.includes('unsupported job type') ||
      msg.includes('missing required') ||
      msg.includes('syntax error') ||
      msg.includes('unauthorized') ||
      msg.includes('forbidden') ||
      msg.includes('bad request') ||
      msg.includes('not found')
    ) {
      return 'NON_RETRYABLE';
    }

    // 2. Retryable pattern checks
    if (
      code === 'ECONNRESET' ||
      code === 'ETIMEDOUT' ||
      code === 'ECONNREFUSED' ||
      code === 'ENOTFOUND' ||
      code === 'EHOSTUNREACH' ||
      code === '503' ||
      code === '504' ||
      msg.includes('timeout') ||
      msg.includes('connection reset') ||
      msg.includes('network error') ||
      msg.includes('service unavailable') ||
      msg.includes('deadlock detected') ||
      msg.includes('too many connections') ||
      msg.includes('temporary') ||
      msg.includes('rate limit')
    ) {
      return 'RETRYABLE';
    }
  }

  // Default fallback for unknown runtime errors: treat as RETRYABLE
  return 'RETRYABLE';
}
