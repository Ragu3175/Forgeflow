import http from 'node:http';
import { register } from '@forgeflow/shared';
import { workerLogger } from '../config/logger';

let server: http.Server | null = null;

/**
 * Starts a dedicated HTTP metrics server on the worker process
 * for Prometheus scraping.
 */
export function startWorkerMetricsServer(port: number = 9102): http.Server {
  if (server) {
    return server;
  }

  server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && (req.url === '/metrics' || req.url === '/metrics/')) {
      try {
        res.setHeader('Content-Type', register.contentType);
        const metrics = await register.metrics();
        res.writeHead(200);
        res.end(metrics);
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Error generating metrics: ${err.message}`);
      }
    } else if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'forgeflow-worker' }));
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  });

  server.listen(port, () => {
    workerLogger.info('worker_metrics_server_started', {
      port,
      path: '/metrics',
    });
    console.log(`[Worker Metrics] 📊 Prometheus metrics endpoint active at http://0.0.0.0:${port}/metrics`);
  });

  server.on('error', (err: any) => {
    workerLogger.error('worker_metrics_server_error', { port }, err);
  });

  return server;
}

/**
 * Stops the worker metrics server gracefully.
 */
export async function stopWorkerMetricsServer(): Promise<void> {
  if (!server) return;

  return new Promise((resolve) => {
    server!.close(() => {
      server = null;
      workerLogger.info('worker_metrics_server_stopped');
      resolve();
    });
  });
}
