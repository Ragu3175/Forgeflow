import { initTracing } from '@forgeflow/shared';
import { env } from './config/env';

// Initialize OpenTelemetry Tracing before importing any instrumented libraries (pg, rabbitmq, etc.)
export const tracing = initTracing({
  serviceName: process.env.OTEL_SERVICE_NAME || 'forgeflow-worker',
  serviceVersion: '0.1.0',
  environment: env.NODE_ENV,
  endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318',
});
