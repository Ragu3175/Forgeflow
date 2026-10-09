import { createClient, RedisClientType } from 'redis';
import { env } from '../config/env';

export const redisClient: RedisClientType = createClient({
  url: env.REDIS_URL,
});

let isConnected = false;

redisClient.on('connect', () => {
  console.log('[Worker Redis] Connecting to Redis...');
});

redisClient.on('ready', () => {
  isConnected = true;
  console.log(`[Worker Redis] ✅ Connected to Redis at ${env.REDIS_URL}`);
});

redisClient.on('error', (err) => {
  isConnected = false;
  console.error('[Worker Redis Error]:', err.message);
});

export async function connectRedis(): Promise<boolean> {
  try {
    if (!redisClient.isOpen) {
      await redisClient.connect();
    }
    return true;
  } catch (err: any) {
    console.warn(`[Worker Redis Warning] Could not connect to Redis: ${err.message}`);
    return false;
  }
}

export async function invalidateJobCache(jobId: string): Promise<void> {
  try {
    if (isConnected && redisClient.isOpen) {
      const key = `job:${jobId}`;
      await redisClient.del(key);
      console.log(`[Worker Cache Invalidation] Cleared Redis cache key '${key}'`);
    }
  } catch (err: any) {
    console.warn(`[Worker Cache Warning] Failed to delete cache for job ${jobId}: ${err.message}`);
  }
}
