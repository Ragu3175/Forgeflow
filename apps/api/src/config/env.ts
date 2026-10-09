import dotenv from 'dotenv';
import path from 'path';

// Load .env from apps/api/.env or current working directory
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config();

export interface EnvConfig {
  PORT: number;
  INSTANCE_ID: string;
  NODE_ENV: string;
  DATABASE_URL: string;
  REDIS_URL: string;
  RABBITMQ_URL: string;
  JWT_SECRET: string;
  JWT_EXPIRES_IN: string;
  CORS_ORIGIN: string;
}

function getEnv(key: string, defaultValue?: string): string {
  const value = process.env[key] || defaultValue;
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export const env: EnvConfig = {
  PORT: parseInt(process.env.PORT || '4000', 10),
  INSTANCE_ID: process.env.INSTANCE_ID || 'api-default',
  NODE_ENV: process.env.NODE_ENV || 'development',
  DATABASE_URL: getEnv(
    'DATABASE_URL',
    'postgresql://postgres:postgres@localhost:5432/forgeflow'
  ),
  REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
  RABBITMQ_URL: process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672',
  JWT_SECRET: getEnv('JWT_SECRET', 'dev_jwt_secret_forgeflow_key_12345'),
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '7d',
  CORS_ORIGIN: process.env.CORS_ORIGIN || 'http://localhost:5173',
};

