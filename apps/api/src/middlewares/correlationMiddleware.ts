import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { createLogger, Logger } from '@forgeflow/shared';
import { env } from '../config/env';

export const apiLogger = createLogger('forgeflow-api', {
  instanceId: env.INSTANCE_ID,
});

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      logger: Logger;
    }
  }
}

/**
 * Middleware that extracts or generates a unique correlation ID (X-Request-ID)
 * for every incoming HTTP request and logs request_started and request_completed events.
 */
export function correlationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const startTime = Date.now();

  // 1. Extract existing correlation ID or generate a new UUID
  const incomingRequestId = req.header('x-request-id') || req.header('x-correlation-id');
  const requestId =
    typeof incomingRequestId === 'string' && incomingRequestId.trim().length > 0
      ? incomingRequestId.trim()
      : crypto.randomUUID();

  req.requestId = requestId;

  // 2. Set response headers for client correlation
  res.setHeader('X-Request-ID', requestId);

  // 3. Create request-scoped child logger
  const requestLogger = apiLogger.child({
    requestId,
    instanceId: env.INSTANCE_ID,
  });
  req.logger = requestLogger;

  // 4. Log request_started
  const path = req.originalUrl || req.url;
  requestLogger.info('request_started', {
    method: req.method,
    path,
    ip: req.ip || req.socket.remoteAddress,
  });

  // 5. Intercept response completion to log request_completed
  res.on('finish', () => {
    const durationMs = Date.now() - startTime;
    requestLogger.info('request_completed', {
      method: req.method,
      path,
      statusCode: res.statusCode,
      durationMs,
    });
  });

  next();
}
