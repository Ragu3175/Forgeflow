import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env';
import { apiLogger } from './correlationMiddleware';

export interface AppError extends Error {
  statusCode?: number;
  details?: any;
  code?: string; // e.g. Postgres error code
}

export function notFoundHandler(req: Request, res: Response): void {
  const logger = req.logger || apiLogger;
  logger.warn('endpoint_not_found', {
    method: req.method,
    path: req.originalUrl || req.url,
  });

  res.status(404).json({
    error: `Endpoint '${req.method} ${req.originalUrl}' not found`,
  });
}

export function errorHandler(
  err: AppError,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const isOperationalError = typeof err.statusCode === 'number' && err.statusCode < 500;
  const statusCode = err.statusCode || 500;
  const logger = req.logger || apiLogger;

  // Log all 5xx or unhandled database errors on the server with structured correlation metadata
  if (statusCode >= 500) {
    logger.error('server_error', {
      method: req.method,
      path: req.originalUrl || req.url,
      statusCode,
    }, err);
  } else {
    logger.warn('client_error', {
      method: req.method,
      path: req.originalUrl || req.url,
      statusCode,
    }, err.message);
  }

  // Sanitize message for clients: never expose raw database/internal errors on 500 in production
  let clientMessage: string;
  if (isOperationalError) {
    clientMessage = err.message || 'Client request error';
  } else if (env.NODE_ENV === 'production') {
    clientMessage = 'An internal server error occurred';
  } else {
    clientMessage = err.message || 'Internal Server Error';
  }

  res.status(statusCode).json({
    error: clientMessage,
    ...(err.details ? { details: err.details } : {}),
  });
}

