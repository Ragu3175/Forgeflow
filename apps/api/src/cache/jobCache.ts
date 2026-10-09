import { Job } from '@forgeflow/shared';
import { redisClient, isRedisReady } from './redis';

export const DEFAULT_JOB_CACHE_TTL_SECONDS = 30;

export function getJobCacheKey(jobId: string): string {
  return `job:${jobId}`;
}

/**
 * Retrieves a cached Job from Redis.
 * Returns null if cache miss, key expired, Redis unavailable, or malformed data.
 */
export async function getJobCache(jobId: string): Promise<Job | null> {
  try {
    if (!isRedisReady()) {
      return null;
    }

    const key = getJobCacheKey(jobId);
    const data = await redisClient.get(key);

    if (!data) {
      return null;
    }

    try {
      const job: Job = JSON.parse(data);
      return job;
    } catch {
      console.warn(`[Redis Cache Warning] Malformed JSON in key ${key}, removing corrupted entry.`);
      await redisClient.del(key).catch(() => {});
      return null;
    }
  } catch (err: any) {
    console.error(`[Redis Cache Error - GET] Failed to get cache for job:${jobId}:`, err.message);
    return null;
  }
}

/**
 * Stores a Job in Redis with a TTL (default 30 seconds).
 * Catches errors gracefully without failing the calling operation.
 */
export async function setJobCache(
  jobId: string,
  job: Job,
  ttlSeconds: number = DEFAULT_JOB_CACHE_TTL_SECONDS
): Promise<void> {
  try {
    if (!isRedisReady()) {
      return;
    }

    const key = getJobCacheKey(jobId);
    const serialized = JSON.stringify(job);

    await redisClient.set(key, serialized, {
      EX: ttlSeconds,
    });
  } catch (err: any) {
    console.error(`[Redis Cache Error - SET] Failed to set cache for job:${jobId}:`, err.message);
  }
}

/**
 * Invalidates / deletes a Job cache entry from Redis.
 * Catches errors gracefully without failing the underlying mutation.
 */
export async function deleteJobCache(jobId: string): Promise<void> {
  try {
    if (!isRedisReady()) {
      return;
    }

    const key = getJobCacheKey(jobId);
    await redisClient.del(key);
    console.log(`[Cache Invalidation] Deleted Redis key ${key}`);
  } catch (err: any) {
    console.error(`[Redis Cache Error - DELETE] Failed to delete cache for job:${jobId}:`, err.message);
  }
}
