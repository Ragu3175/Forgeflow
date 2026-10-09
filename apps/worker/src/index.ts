// 1. Tracing MUST be imported and initialized before db, rabbitmq, or other instrumented modules
import { tracing } from './tracing';

import { env } from './config/env';
import { pool } from './db';
import { connectRedis } from './cache/redis';
import { startConsumer } from './queue/consumer';
import { startWorkerMetricsServer, stopWorkerMetricsServer } from './metrics';
import { workerLogger, WORKER_ID } from './config/logger';

async function bootstrapWorker() {
  workerLogger.info('worker_bootstrapping', {
    workerId: WORKER_ID,
    env: env.NODE_ENV,
  });

  try {
    // 1. Verify PostgreSQL connection
    const dbTest = await pool.query('SELECT NOW() as now');
    workerLogger.info('worker_db_connected', { time: dbTest.rows[0].now });

    // 2. Connect to Redis (for cache invalidation)
    await connectRedis();

    // 3. Start RabbitMQ message consumer
    await startConsumer();

    // 4. Start dedicated Prometheus metrics HTTP server (Phase 9.2)
    const metricsPort = parseInt(process.env.METRICS_PORT || '9102', 10);
    startWorkerMetricsServer(metricsPort);

  } catch (err: any) {
    workerLogger.error('worker_startup_failed', {}, err);
    process.exit(1);
  }
}

// Graceful shutdown handlers
process.on('SIGINT', async () => {
  workerLogger.info('worker_shutting_down', { signal: 'SIGINT' });
  await stopWorkerMetricsServer().catch(() => {});
  await tracing.shutdown().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(0);
});

process.on('SIGTERM', async () => {
  workerLogger.info('worker_shutting_down', { signal: 'SIGTERM' });
  await stopWorkerMetricsServer().catch(() => {});
  await tracing.shutdown().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(0);
});

bootstrapWorker();


