import { Router } from 'express';
import { authRoutes } from './authRoutes';
import { jobRoutes } from './jobRoutes';
import { pool } from '../db';
import { isRedisReady } from '../cache/redis';
import { isRabbitMQReady, getQueueDepth } from '../queue/rabbitmq';
import { env } from '../config/env';
import { register, queueDepthGauge, FORGEFLOW_JOBS_QUEUE } from '@forgeflow/shared';

export const apiRouter = Router();

/**
 * Liveness endpoint (GET /health)
 * Lightweight check to confirm that the HTTP process is responsive.
 */
apiRouter.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'ForgeFlow API',
    instance: env.INSTANCE_ID,
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

/**
 * Readiness endpoint (GET /ready)
 * Verifies that essential downstream dependencies (PostgreSQL, Redis, RabbitMQ)
 * are healthy and the API instance can actively serve traffic.
 */
apiRouter.get('/ready', async (req, res) => {
  let dbOk = false;
  let redisOk = false;
  let rmqOk = false;

  try {
    await pool.query('SELECT 1');
    dbOk = true;
  } catch {
    dbOk = false;
  }

  redisOk = isRedisReady();
  rmqOk = isRabbitMQReady();

  const isReady = dbOk && redisOk && rmqOk;
  const statusCode = isReady ? 200 : 503;

  res.status(statusCode).json({
    status: isReady ? 'ready' : 'unhealthy',
    instance: env.INSTANCE_ID,
    timestamp: new Date().toISOString(),
    dependencies: {
      postgres: dbOk ? 'ok' : 'down',
      redis: redisOk ? 'ok' : 'down',
      rabbitmq: rmqOk ? 'ok' : 'down',
    },
  });
});

/**
 * Prometheus Metrics endpoint (GET /metrics) (Phase 9.2)
 * Exposes Prometheus text-formatted metrics for scraping.
 */
apiRouter.get('/metrics', async (req, res) => {
  try {
    // Update queue depth metric from RabbitMQ before scraping
    const depth = await getQueueDepth(FORGEFLOW_JOBS_QUEUE);
    if (depth !== null) {
      queueDepthGauge.set({ queue: FORGEFLOW_JOBS_QUEUE }, depth);
    }

    res.setHeader('Content-Type', register.contentType);
    res.send(await register.metrics());
  } catch (err: any) {
    res.status(500).send(`Error generating metrics: ${err.message}`);
  }
});

apiRouter.use('/auth', authRoutes);
apiRouter.use('/jobs', jobRoutes);


