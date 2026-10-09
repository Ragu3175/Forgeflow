import { createLogger } from '@forgeflow/shared';
import os from 'os';

export const WORKER_ID =
  process.env.WORKER_ID ||
  `worker-${process.pid}-${os.hostname()}-${Math.random().toString(36).substring(2, 6)}`;

export const workerLogger = createLogger('forgeflow-worker', {
  workerId: WORKER_ID,
});
