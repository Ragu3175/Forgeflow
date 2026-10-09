import {
  trace,
  context as otelContext,
  propagation,
  type Span,
  SpanStatusCode,
  type SpanOptions,
  SpanKind,
  type Tracer,
  type Context,
  ROOT_CONTEXT,
} from '@opentelemetry/api';
import {
  W3CTraceContextPropagator,
  CompositePropagator,
  W3CBaggagePropagator,
} from '@opentelemetry/core';

// Ensure global propagator is always initialized to standard W3C Trace Context
propagation.setGlobalPropagator(
  new CompositePropagator({
    propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
  })
);

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface TracingOptions {
  serviceName?: string;
  serviceVersion?: string;
  environment?: string;
  endpoint?: string;
  enabled?: boolean;
  useSimpleSpanProcessor?: boolean; // Useful for tests/immediate export
}

export interface ActiveTraceInfo {
  traceId?: string;
  spanId?: string;
  traceFlags?: number;
}

let sdkInstance: any = null;
let isTracingInitialized = false;
let isTracingEnabled = false;

// Sensitive attribute keys that should NEVER be recorded in spans
const SENSITIVE_KEYS = [
  'password',
  'password_hash',
  'token',
  'jwt',
  'authorization',
  'secret',
  'cookie',
  'apikey',
  'api_key',
  'payload',
  'credentials',
];

/**
 * Sanitizes span attributes to guarantee sensitive user credentials/tokens are never exported.
 */
export function sanitizeSpanAttributes(attributes: Record<string, any>): Record<string, any> {
  const sanitized: Record<string, any> = {};
  for (const [key, value] of Object.entries(attributes)) {
    const lower = key.toLowerCase();
    const isSensitive = SENSITIVE_KEYS.some((s) => lower === s || lower.endsWith(`.${s}`));
    if (isSensitive) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = JSON.stringify(value).slice(0, 256);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

// ============================================================================
// Initialization & Lifecycle
// ============================================================================

/**
 * Initializes the OpenTelemetry SDK with OTLP HTTP trace exporter and standard instrumentations.
 */
export function initTracing(options: TracingOptions = {}): {
  enabled: boolean;
  shutdown: () => Promise<void>;
  tracer: Tracer;
} {
  const enabled =
    options.enabled ??
    (process.env.OTEL_TRACES_ENABLED !== 'false' && process.env.OTEL_SDK_DISABLED !== 'true');

  const serviceName =
    options.serviceName || process.env.OTEL_SERVICE_NAME || 'forgeflow';
  const serviceVersion =
    options.serviceVersion || process.env.SERVICE_VERSION || '0.1.0';
  const environment =
    options.environment || process.env.OTEL_ENVIRONMENT || process.env.NODE_ENV || 'development';
  const rawEndpoint =
    options.endpoint || process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318';
  
  const exporterUrl = rawEndpoint.endsWith('/v1/traces')
    ? rawEndpoint
    : `${rawEndpoint.replace(/\/$/, '')}/v1/traces`;

  isTracingEnabled = enabled;

  if (!enabled) {
    return {
      enabled: false,
      shutdown: async () => {},
      tracer: trace.getTracer(serviceName, serviceVersion),
    };
  }

  if (isTracingInitialized && sdkInstance) {
    return {
      enabled: true,
      shutdown: () => sdkInstance?.shutdown() || Promise.resolve(),
      tracer: trace.getTracer(serviceName, serviceVersion),
    };
  }

  try {
    const { NodeSDK } = require('@opentelemetry/sdk-node');
    const { BatchSpanProcessor, SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-base');
    const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
    const { resourceFromAttributes, defaultResource } = require('@opentelemetry/resources');
    const {
      SEMRESATTRS_SERVICE_NAME,
      SEMRESATTRS_SERVICE_VERSION,
      SEMRESATTRS_DEPLOYMENT_ENVIRONMENT,
    } = require('@opentelemetry/semantic-conventions');
    const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
    const { ExpressInstrumentation } = require('@opentelemetry/instrumentation-express');
    const { PgInstrumentation } = require('@opentelemetry/instrumentation-pg');

    const resource = defaultResource().merge(
      resourceFromAttributes({
        [SEMRESATTRS_SERVICE_NAME]: serviceName,
        [SEMRESATTRS_SERVICE_VERSION]: serviceVersion,
        [SEMRESATTRS_DEPLOYMENT_ENVIRONMENT]: environment,
      })
    );

    const traceExporter = new OTLPTraceExporter({
      url: exporterUrl,
      timeoutMillis: 5000,
    });

    const spanProcessor = options.useSimpleSpanProcessor
      ? new SimpleSpanProcessor(traceExporter)
      : new BatchSpanProcessor(traceExporter, {
          maxExportBatchSize: 512,
          scheduledDelayMillis: 1000,
        });

    const sdk = new NodeSDK({
      resource,
      spanProcessor,
      instrumentations: [
        new HttpInstrumentation({
          ignoreIncomingRequestHook: (req: any) => {
            const url = req.url || '';
            return (
              url.includes('/health') ||
              url.includes('/ready') ||
              url.includes('/metrics') ||
              url.includes('/nginx-health')
            );
          },
        }),
        new ExpressInstrumentation(),
        new PgInstrumentation({
          enhancedDatabaseReporting: true,
        }),
      ],
    });

    sdk.start();
    sdkInstance = sdk;
    isTracingInitialized = true;
  } catch (err) {
    console.warn('[OpenTelemetry] Failed to initialize NodeSDK:', err);
  }

  const shutdown = async () => {
    if (sdkInstance) {
      await sdkInstance.shutdown();
      sdkInstance = null;
      isTracingInitialized = false;
    }
  };

  return {
    enabled: true,
    shutdown,
    tracer: trace.getTracer(serviceName, serviceVersion),
  };
}

/**
 * Gets a named tracer instance.
 */
export function getTracer(name = 'forgeflow', version = '0.1.0'): Tracer {
  return trace.getTracer(name, version);
}

// ============================================================================
// Trace Context Extraction & Injection (W3C Trace Context)
// ============================================================================

/**
 * Injects the currently active or specified OpenTelemetry trace context into a carrier dictionary
 * using standard W3C 'traceparent' and 'tracestate' format.
 */
export function injectTraceContext(
  carrier: Record<string, any> = {},
  ctx: Context = otelContext.active()
): Record<string, any> {
  propagation.inject(ctx, carrier);
  return carrier;
}

/**
 * Extracts W3C Trace Context from an incoming message/request header dictionary.
 */
export function extractTraceContext(
  carrier: Record<string, any> = {},
  parentContext: Context = ROOT_CONTEXT
): Context {
  // Normalize header keys (lowercase) so AMQP or HTTP variations match W3C
  const normalizedCarrier: Record<string, string> = {};
  for (const [key, value] of Object.entries(carrier)) {
    if (value !== undefined && value !== null) {
      normalizedCarrier[key.toLowerCase()] = String(value);
    }
  }

  return propagation.extract(parentContext, normalizedCarrier);
}

/**
 * Returns the currently active traceId, spanId, and traceFlags from context.
 */
export function getActiveTraceContext(): ActiveTraceInfo {
  const currentSpan = trace.getActiveSpan();
  if (!currentSpan) {
    return {};
  }
  const spanCtx = currentSpan.spanContext();
  return {
    traceId: spanCtx.traceId,
    spanId: spanCtx.spanId,
    traceFlags: spanCtx.traceFlags,
  };
}

/**
 * Executes an async or sync function within a newly created active span, automatically
 * managing lifecycle, error recording, and span status.
 */
export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T> | T,
  options: SpanOptions = {},
  ctx: Context = otelContext.active()
): Promise<T> {
  const tracer = getTracer();
  const sanitizedAttrs = options.attributes ? sanitizeSpanAttributes(options.attributes) : undefined;
  const mergedOptions = { ...options, attributes: sanitizedAttrs };

  return tracer.startActiveSpan(name, mergedOptions, ctx, async (span: Span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err: any) {
      span.recordException(err);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err?.message || 'Operation failed',
      });
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Manually creates a detached span (useful when passing across non-lexical async scopes).
 */
export function createSpan(
  name: string,
  options: SpanOptions = {},
  ctx: Context = otelContext.active()
): Span {
  const tracer = getTracer();
  const sanitizedAttrs = options.attributes ? sanitizeSpanAttributes(options.attributes) : undefined;
  return tracer.startSpan(name, { ...options, attributes: sanitizedAttrs }, ctx);
}

export {
  trace,
  otelContext,
  propagation,
  type Span,
  SpanStatusCode,
  SpanKind,
  type Tracer,
  type Context,
};
