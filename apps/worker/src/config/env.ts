import dotenv from 'dotenv';
import path from 'path';

// Load .env from apps/worker/.env, apps/api/.env, or current directory
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../../apps/api/.env') });
dotenv.config();

export interface WorkerEnvConfig {
  NODE_ENV: string;
  DATABASE_URL: string;
  REDIS_URL: string;
  RABBITMQ_URL: string;
}

function getEnv(key: string, defaultValue?: string): string {
  const value = process.env[key] || defaultValue;
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export const env: WorkerEnvConfig = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  DATABASE_URL: getEnv(
    'DATABASE_URL',
    'postgresql://postgres:postgres@localhost:5432/forgeflow'
  ),
  REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
  RABBITMQ_URL: process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672',
};
