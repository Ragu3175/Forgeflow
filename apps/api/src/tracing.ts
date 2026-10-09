import { initTracing } from '@forgeflow/shared';
import { env } from './config/env';

// Initialize OpenTelemetry Tracing before importing any instrumented libraries (express, http, pg)
export const tracing = initTracing({
  serviceName: process.env.OTEL_SERVICE_NAME || (env.INSTANCE_ID ? `forgeflow-api-${env.INSTANCE_ID}` : 'forgeflow-api'),
  serviceVersion: '0.1.0',
  environment: env.NODE_ENV,
  endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318',
});
