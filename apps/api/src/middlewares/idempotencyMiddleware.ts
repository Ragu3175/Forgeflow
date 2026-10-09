import { Request, Response, NextFunction } from 'express';

declare global {
  namespace Express {
    interface Request {
      idempotencyKey?: string;
    }
  }
}

export const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

export function requireIdempotencyKey(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const headerValue =
    req.headers['idempotency-key'] ?? req.headers['Idempotency-Key'];

  if (headerValue === undefined || headerValue === null) {
    res.status(400).json({
      error: 'Validation failed',
      details: [
        {
          field: 'headers.idempotency-key',
          message: 'Idempotency-Key header is required.',
        },
      ],
    });
    return;
  }

  const rawKey = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  const key = typeof rawKey === 'string' ? rawKey.trim() : '';

  if (key.length === 0) {
    res.status(400).json({
      error: 'Validation failed',
      details: [
        {
          field: 'headers.idempotency-key',
          message: 'Idempotency-Key header cannot be empty.',
        },
      ],
    });
    return;
  }

  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    res.status(400).json({
      error: 'Validation failed',
      details: [
        {
          field: 'headers.idempotency-key',
          message: `Idempotency-Key header cannot exceed ${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`,
        },
      ],
    });
    return;
  }

  req.idempotencyKey = key;
  next();
}
