import { Request, Response, NextFunction } from 'express';
import {
  httpRequestsTotal,
  httpRequestDurationSeconds,
  normalizeMetricRoute,
} from '@forgeflow/shared';

/**
 * Express middleware to observe HTTP request counts and latency histograms.
 * Labels: method, route, status_code (Low Cardinality)
 */
export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Do not record metrics for /metrics scraping itself to avoid recursive skew
  if (req.path === '/metrics') {
    return next();
  }

  const startTime = process.hrtime();

  res.on('finish', () => {
    const diff = process.hrtime(startTime);
    const durationSeconds = diff[0] + diff[1] / 1e9;

    // Resolve normalized route pattern (e.g. /jobs/:id instead of raw UUID)
    const routePattern = req.route?.path
      ? `${req.baseUrl || ''}${req.route.path}`
      : undefined;

    const normalizedRoute = normalizeMetricRoute(req.path, routePattern);
    const method = req.method.toUpperCase();
    const statusCode = String(res.statusCode);

    // Increment Counter
    httpRequestsTotal.inc({
      method,
      route: normalizedRoute,
      status_code: statusCode,
    });

    // Record Latency Histogram
    httpRequestDurationSeconds.observe(
      {
        method,
        route: normalizedRoute,
        status_code: statusCode,
      },
      durationSeconds
    );
  });

  next();
}
