import { Router } from 'express';
import { jobController } from '../controllers/jobController';
import { authMiddleware } from '../middlewares/authMiddleware';
import { requireIdempotencyKey } from '../middlewares/idempotencyMiddleware';
import {
  validateBody,
  validateQuery,
  createJobSchema,
  jobsQuerySchema,
} from '../middlewares/validateMiddleware';

export const jobRoutes = Router();

// Apply authMiddleware to all job routes
jobRoutes.use(authMiddleware);

// POST /jobs - Create new job (Requires authentication & Idempotency-Key header)
jobRoutes.post(
  '/',
  requireIdempotencyKey,
  validateBody(createJobSchema),
  jobController.createJob.bind(jobController)
);

// GET /jobs - List jobs with filtering & pagination
jobRoutes.get(
  '/',
  validateQuery(jobsQuerySchema),
  jobController.getJobs.bind(jobController)
);

// GET /jobs/stats - Get user's job statistics
jobRoutes.get(
  '/stats',
  jobController.getJobStats.bind(jobController)
);

// GET /jobs/:id - Get specific job details
jobRoutes.get(
  '/:id',
  jobController.getJobById.bind(jobController)
);

// POST /jobs/:id/cancel - Cancel a pending job
jobRoutes.post(
  '/:id/cancel',
  jobController.cancelJob.bind(jobController)
);
