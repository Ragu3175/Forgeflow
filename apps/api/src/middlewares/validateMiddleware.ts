import { Request, Response, NextFunction } from 'express';
import { z, ZodError } from 'zod';
import { JOB_TYPES, JOB_STATUSES } from '@forgeflow/shared';

export const registerSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters long'),
  name: z.string().min(1, 'Name is required'),
});

export const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

export const createJobSchema = z.object({
  type: z.enum(JOB_TYPES as [string, ...string[]], {
    errorMap: () => ({
      message: `Invalid job type. Must be one of: ${JOB_TYPES.join(', ')}`,
    }),
  }),
  payload: z.record(z.any()).optional().default({}),
});

export const jobsQuerySchema = z.object({
  status: z.enum(JOB_STATUSES as [string, ...string[]]).optional(),
  type: z.enum(JOB_TYPES as [string, ...string[]]).optional(),
  limit: z.coerce.number().int().positive().max(100).optional().default(50),
  offset: z.coerce.number().int().nonnegative().optional().default(0),
});

export function validateBody(schema: z.ZodSchema) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        const errors = err.errors.map((e) => ({
          field: e.path.join('.'),
          message: e.message,
        }));
        res.status(400).json({
          error: 'Validation failed',
          details: errors,
        });
        return;
      }
      next(err);
    }
  };
}

export function validateQuery(schema: z.ZodSchema) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      req.query = schema.parse(req.query) as any;
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        const errors = err.errors.map((e) => ({
          field: e.path.join('.'),
          message: e.message,
        }));
        res.status(400).json({
          error: 'Query validation failed',
          details: errors,
        });
        return;
      }
      next(err);
    }
  };
}
