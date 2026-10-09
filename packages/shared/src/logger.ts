export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  service?: string;
  instanceId?: string;
  workerId?: string;
  requestId?: string;
  jobId?: string;
  traceId?: string;
  spanId?: string;
  durationMs?: number;
  [key: string]: any;
}

export interface StructuredError {
  name?: string;
  message: string;
  stack?: string;
  code?: string | number;
  statusCode?: number;
  [key: string]: any;
}

export interface StructuredLogEntry {
  timestamp: string;
  level: LogLevel;
  service: string;
  event: string;
  message?: string;
  requestId?: string;
  jobId?: string;
  traceId?: string;
  spanId?: string;
  instanceId?: string;
  workerId?: string;
  durationMs?: number;
  error?: StructuredError;
  [key: string]: any;
}

export type LogWriter = (line: string) => void;

const SENSITIVE_KEY_PATTERNS = [
  'password',
  'password_hash',
  'token',
  'authorization',
  'jwt',
  'secret',
  'jwt_secret',
  'credentials',
  'apikey',
  'api_key',
  'access_token',
  'refresh_token',
  'cookie',
  'session',
];

/**
 * Recursively sanitizes an object, removing sensitive credentials and protecting against circular structures.
 */
export function sanitizeLogData(obj: any, seen: WeakSet<object> = new WeakSet(), depth = 0): any {
  if (depth > 8) return '[MAX_DEPTH]';
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') {
    // Redact JWT-like strings or Bearer headers if passed directly
    if (/Bearer\s+[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.?[A-Za-z0-9-_.+/=]*/i.test(obj)) {
      return '[REDACTED_AUTH_HEADER]';
    }
    return obj;
  }
  if (typeof obj === 'number' || typeof obj === 'boolean') return obj;

  if (obj instanceof Error) {
    const errorObj: StructuredError = {
      name: obj.name,
      message: obj.message,
      stack: obj.stack,
    };
    if ((obj as any).code) errorObj.code = (obj as any).code;
    if ((obj as any).statusCode) errorObj.statusCode = (obj as any).statusCode;
    return errorObj;
  }

  if (typeof obj === 'object') {
    if (seen.has(obj)) {
      return '[CIRCULAR]';
    }
    seen.add(obj);

    if (Array.isArray(obj)) {
      return obj.map((item) => sanitizeLogData(item, seen, depth + 1));
    }

    const cleaned: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
      const lowerKey = key.toLowerCase();
      const isSensitive = SENSITIVE_KEY_PATTERNS.some((pat) =>
        lowerKey === pat || lowerKey.includes('password') || lowerKey.includes('secret')
      );

      if (isSensitive) {
        cleaned[key] = '[REDACTED]';
      } else {
        cleaned[key] = sanitizeLogData(value, seen, depth + 1);
      }
    }
    return cleaned;
  }

  return String(obj);
}

export class Logger {
  private defaultContext: LogContext;
  private writer: LogWriter;

  constructor(defaultContext: LogContext = {}, writer: LogWriter = (line) => console.log(line)) {
    this.defaultContext = {
      service: 'forgeflow',
      ...defaultContext,
    };
    this.writer = writer;
  }

  /**
   * Creates a child logger with additional persistent context (e.g. requestId, jobId, workerId).
   */
  child(context: LogContext): Logger {
    return new Logger(
      {
        ...this.defaultContext,
        ...context,
      },
      this.writer
    );
  }

  /**
   * Emits a structured JSON log entry.
   */
  log(
    level: LogLevel,
    event: string,
    context?: LogContext,
    message?: string,
    err?: any
  ): StructuredLogEntry {
    const merged = {
      ...this.defaultContext,
      ...context,
    };

    const sanitized = sanitizeLogData(merged);

    const entry: StructuredLogEntry = {
      timestamp: new Date().toISOString(),
      level,
      service: sanitized.service || 'forgeflow',
      event,
    };

    if (message) {
      entry.message = message;
    }

    if (sanitized.instanceId) {
      entry.instanceId = sanitized.instanceId;
    }
    if (sanitized.workerId) {
      entry.workerId = sanitized.workerId;
    }
    if (sanitized.requestId) {
      entry.requestId = sanitized.requestId;
    }
    if (sanitized.jobId) {
      entry.jobId = sanitized.jobId;
    }
    
    // Auto-enrich with OpenTelemetry traceId and spanId if active (Phase 9.4)
    if (sanitized.traceId) {
      entry.traceId = sanitized.traceId;
    }
    if (sanitized.spanId) {
      entry.spanId = sanitized.spanId;
    }
    if (!entry.traceId || !entry.spanId) {
      try {
        const { getActiveTraceContext } = require('./tracing');
        const activeTrace = getActiveTraceContext();
        if (!entry.traceId && activeTrace.traceId) {
          entry.traceId = activeTrace.traceId;
        }
        if (!entry.spanId && activeTrace.spanId) {
          entry.spanId = activeTrace.spanId;
        }
      } catch {
        // tracing module not initialized / unavailable
      }
    }

    if (typeof sanitized.durationMs === 'number') {
      entry.durationMs = sanitized.durationMs;
    }

    if (err) {
      entry.error = sanitizeLogData(err instanceof Error ? err : new Error(String(err)));
    } else if (sanitized.error) {
      entry.error = sanitized.error;
      delete sanitized.error;
    }

    // Append extra context fields
    for (const [k, v] of Object.entries(sanitized)) {
      if (
        ![
          'service',
          'instanceId',
          'workerId',
          'requestId',
          'jobId',
          'durationMs',
          'level',
          'event',
          'timestamp',
          'message',
          'error',
        ].includes(k)
      ) {
        entry[k] = v;
      }
    }

    this.writer(JSON.stringify(entry));
    return entry;
  }

  info(event: string, context?: LogContext, message?: string): StructuredLogEntry {
    return this.log('info', event, context, message);
  }

  warn(event: string, context?: LogContext, message?: string): StructuredLogEntry {
    return this.log('warn', event, context, message);
  }

  error(event: string, context?: LogContext, err?: any, message?: string): StructuredLogEntry {
    return this.log('error', event, context, message, err);
  }

  debug(event: string, context?: LogContext, message?: string): StructuredLogEntry {
    return this.log('debug', event, context, message);
  }
}

export function createLogger(
  service: string,
  initialContext?: LogContext,
  writer?: LogWriter
): Logger {
  return new Logger({ service, ...initialContext }, writer);
}
