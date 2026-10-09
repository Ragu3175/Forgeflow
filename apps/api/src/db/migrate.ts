import fs from 'fs';
import path from 'path';
import { Client } from 'pg';
import { pool } from './index';
import { env } from '../config/env';

async function ensureDatabaseExists() {
  try {
    const url = new URL(env.DATABASE_URL);
    const targetDbName = url.pathname.replace(/^\//, '');

    if (!targetDbName) return;

    // Connect to default 'postgres' database to check/create target database
    const adminUrl = new URL(env.DATABASE_URL);
    adminUrl.pathname = '/postgres';

    const client = new Client({ connectionString: adminUrl.toString() });
    await client.connect();

    try {
      const res = await client.query<{ exists: boolean }>(
        'SELECT 1 FROM pg_database WHERE datname = $1',
        [targetDbName]
      );

      if (res.rowCount === 0) {
        console.log(`[Migrate] Database '${targetDbName}' does not exist. Creating it now...`);
        // Database names cannot be parameterized in CREATE DATABASE
        await client.query(`CREATE DATABASE "${targetDbName}"`);
        console.log(`[Migrate] Database '${targetDbName}' created successfully.`);
      }
    } finally {
      await client.end();
    }
  } catch (err: any) {
    console.warn('[Migrate] Notice during database check:', err.message);
  }
}

export async function runMigrations() {
  await ensureDatabaseExists();

  const client = await pool.connect();
  try {
    console.log('[Migrate] Starting database migrations...');

    // 1. Create schema_migrations table if not exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // 2. Read migration files
    const migrationsDir = path.join(__dirname, 'migrations');
    if (!fs.existsSync(migrationsDir)) {
      console.log('[Migrate] No migrations directory found.');
      return;
    }

    const files = fs
      .readdirSync(migrationsDir)
      .filter((file) => file.endsWith('.sql'))
      .sort();

    // 3. Get applied migrations
    const { rows: appliedRows } = await client.query<{ version: string }>(
      'SELECT version FROM schema_migrations'
    );
    const appliedSet = new Set(appliedRows.map((r) => r.version));

    // 4. Run unapplied migrations
    let count = 0;
    for (const file of files) {
      if (!appliedSet.has(file)) {
        console.log(`[Migrate] Applying migration: ${file}...`);
        const filePath = path.join(migrationsDir, file);
        const sql = fs.readFileSync(filePath, 'utf-8');

        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query(
            'INSERT INTO schema_migrations (version) VALUES ($1)',
            [file]
          );
          await client.query('COMMIT');
          console.log(`[Migrate] Successfully applied: ${file}`);
          count++;
        } catch (err) {
          await client.query('ROLLBACK');
          console.error(`[Migrate] Failed to apply ${file}:`, err);
          throw err;
        }
      }
    }

    if (count === 0) {
      console.log('[Migrate] Database schema is already up to date.');
    } else {
      console.log(`[Migrate] Completed! ${count} migration(s) applied.`);
    }
  } finally {
    client.release();
  }
}

// Allow direct CLI execution: tsx src/db/migrate.ts
if (require.main === module) {
  runMigrations()
    .then(async () => {
      await pool.end();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error('[Migrate] Fatal migration error:', err);
      await pool.end();
      process.exit(1);
    });
}
