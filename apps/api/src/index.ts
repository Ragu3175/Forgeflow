// 1. Tracing MUST be imported and initialized before express, http, pg, or other instrumented modules
import { tracing } from './tracing';

import express from 'express';
import cors from 'cors';
import { env } from './config/env';
import { apiRouter } from './routes';
import { errorHandler, notFoundHandler } from './middlewares/errorHandler';
import { correlationMiddleware, apiLogger } from './middlewares/correlationMiddleware';
import { metricsMiddleware } from './middlewares/metricsMiddleware';
import { connectRedis, closeRedis } from './cache/redis';
import { connectRabbitMQ, closeRabbitMQ } from './queue/rabbitmq';
import { outboxPublisher } from './outbox/outboxPublisher';
import { pool } from './db';

const app = express();

// Security & Parsing Middlewares
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps, curl, Postman)
      if (!origin) return callback(null, true);
      // In development or if origin matches CORS_ORIGIN
      return callback(null, true);
    },
    credentials: true,
  })
);
app.use(express.json());

// Prometheus Metrics Middleware (Phase 9.2)
app.use(metricsMiddleware);

// Correlation ID & Request Structured Logging Middleware (Phase 9.1)
app.use(correlationMiddleware);

// Instance Identification Response Header (Phase 8)
app.use((req, res, next) => {
  res.setHeader('X-ForgeFlow-Instance', env.INSTANCE_ID);
  next();
});

// Mount API routes
app.use('/', apiRouter);

// 404 and Error Handling
app.use(notFoundHandler);
app.use(errorHandler);


const PORT = env.PORT;

if (process.env.NODE_ENV !== 'test') {
  const server = app.listen(PORT, async () => {
    console.log(`========================================`);
    console.log(` 🚀 ForgeFlow API [${env.INSTANCE_ID}] running on port ${PORT}`);
    console.log(` 🌐 Environment: ${env.NODE_ENV}`);
    console.log(` 🔗 URL: http://localhost:${PORT}`);
    console.log(`========================================`);

    // Connect to Redis on startup
    await connectRedis();

    // Connect to RabbitMQ on startup
    await connectRabbitMQ();

    // Start Transactional Outbox Publisher loop
    outboxPublisher.start();
  });

  const gracefulShutdown = async (signal: string) => {
    console.log(`[API ${env.INSTANCE_ID}] Received ${signal}. Starting graceful shutdown...`);

    // 1. Stop accepting new HTTP requests
    server.close(async () => {
      console.log(`[API ${env.INSTANCE_ID}] HTTP server stopped accepting connections.`);

      try {
        // 2. Stop Outbox Publisher polling loop
        outboxPublisher.stop();

        // 3. Close RabbitMQ channel and connection
        await closeRabbitMQ();

        // 4. Close Redis client
        await closeRedis();

        // 5. Drain and close database pool
        await pool.end();
        console.log(`[API ${env.INSTANCE_ID}] PostgreSQL connection pool closed.`);

        // 6. Flush and shutdown OpenTelemetry tracer provider
        await tracing.shutdown().catch(() => {});
      } catch (err: any) {
        console.error(`[API ${env.INSTANCE_ID}] Error during resource cleanup:`, err.message);
      } finally {
        console.log(`[API ${env.INSTANCE_ID}] ✅ Graceful shutdown complete. Exiting.`);
        process.exit(0);
      }
    });

    // Fallback: force exit after 10 seconds if graceful shutdown is blocked
    setTimeout(() => {
      console.error(`[API ${env.INSTANCE_ID}] Graceful shutdown timed out. Forcing exit.`);
      process.exit(1);
    }, 10000).unref();
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

export default app;

