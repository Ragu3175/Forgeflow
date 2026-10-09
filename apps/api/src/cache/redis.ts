import { createClient, RedisClientType } from 'redis';
import { env } from '../config/env';

export const redisClient: RedisClientType = createClient({
  url: env.REDIS_URL,
});

let isConnected = false;

redisClient.on('connect', () => {
  console.log('[Redis] Connecting to Redis server...');
});

redisClient.on('ready', () => {
  isConnected = true;
  console.log(`[Redis] ✅ Connected successfully to ${env.REDIS_URL}`);
});

redisClient.on('error', (err) => {
  isConnected = false;
  console.error('[Redis Error]:', err.message);
});

redisClient.on('end', () => {
  isConnected = false;
  console.log('[Redis] Connection closed.');
});

/**
 * Initializes and connects to Redis during server startup.
 * Catches connection errors gracefully so API continues running even if Redis is temporarily unreachable.
 */
export async function connectRedis(): Promise<boolean> {
  try {
    if (!redisClient.isOpen) {
      await redisClient.connect();
    }
    return true;
  } catch (err: any) {
    console.warn(`[Redis Warning] Failed to connect to Redis at ${env.REDIS_URL}: ${err.message}`);
    console.warn('[Redis Warning] API will continue running without Redis cache.');
    return false;
  }
}

export function isRedisReady(): boolean {
  return isConnected && redisClient.isOpen;
}

/**
 * Closes Redis client gracefully.
 */
export async function closeRedis(): Promise<void> {
  try {
    if (redisClient.isOpen) {
      await redisClient.quit();
      console.log('[Redis] Disconnected gracefully.');
    }
  } catch (err: any) {
    console.warn('[Redis Warning] Error while disconnecting Redis:', err.message);
  }
}

