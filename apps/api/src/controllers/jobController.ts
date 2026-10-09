import { Request, Response, NextFunction } from 'express';
import { jobService } from '../services/jobService';
import { JobsListQuery } from '@forgeflow/shared';

export class JobController {
  async createJob(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user!.id;
      const idempotencyKey = req.idempotencyKey!;
      const requestId = req.requestId;
      const { job, isIdempotentReplay } = await jobService.createJob(
        userId,
        req.body,
        idempotencyKey,
        requestId
      );

      if (isIdempotentReplay) {
        res.setHeader('Idempotent-Replayed', 'true');
        res.status(200).json(job);
      } else {
        res.status(201).json(job);
      }
    } catch (err) {
      next(err);
    }
  }


  async getJobs(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user!.id;
      const query = req.query as unknown as JobsListQuery;
      const result = await jobService.getJobs(userId, query);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }

  async getJobStats(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user!.id;
      const stats = await jobService.getJobStats(userId);
      res.status(200).json(stats);
    } catch (err) {
      next(err);
    }
  }

  async getJobById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user!.id;
      const { id } = req.params;
      const job = await jobService.getJobById(id, userId);
      res.status(200).json(job);
    } catch (err) {
      next(err);
    }
  }

  async cancelJob(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user!.id;
      const { id } = req.params;
      const job = await jobService.cancelJob(id, userId);
      res.status(200).json(job);
    } catch (err) {
      next(err);
    }
  }
}

export const jobController = new JobController();
