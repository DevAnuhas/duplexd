import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

import { requireDatabaseUrl } from '@/db/env';

/**
 * Database plumbing shared by the database-backed tests.
 *
 * Everything here goes through `requireDatabaseUrl()` — the same fail-closed
 * entry point the application uses — rather than reading `process.env` itself.
 * That is not tidiness: these helpers drop and recreate schemas, and an empty
 * connection string handed to a libpq-style client means "use the defaults",
 * which on a developer machine is the local PostgreSQL holding unrelated data.
 * Borrowing the application's guard means this file cannot be the place that
 * forgets it.
 */

/** Committed migrations, resolved absolutely so the runner's cwd is irrelevant. */
const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

/** Every table the data model requires, after migrations have applied. */
export const EXPECTED_TABLES = [
  'accounts',
  'api_keys',
  'assistants',
  'auth_accounts',
  'call_events',
  'call_rate_limits',
  'calls',
  'sessions',
  'users',
  'verifications',
] as const;

/** Opens a pool against the configured database. The caller ends it. */
export function openTestPool(): pg.Pool {
  return new pg.Pool({ connectionString: requireDatabaseUrl() });
}

/**
 * Runs `body` with a pool, ending it afterwards even when `body` throws.
 *
 * A leaked pool keeps the vitest process alive after the run finishes, which
 * looks like a hung suite rather than a leak and wastes an afternoon.
 */
export async function withTestPool<T>(
  body: (pool: pg.Pool) => Promise<T>,
): Promise<T> {
  const pool = openTestPool();

  try {
    return await body(pool);
  } finally {
    await pool.end();
  }
}

/**
 * Drops the database back to genuinely empty and applies the committed
 * migrations.
 *
 * "Empty" is the contract's definition, not a convenient approximation: the
 * `public` schema is dropped and recreated **and** Drizzle's `drizzle` schema —
 * which holds `__drizzle_migrations` — is dropped too. Dropping only `public`
 * would leave the migration ledger behind, so `migrate()` would decide it had
 * already run everything and apply nothing, and the test would pass against a
 * database with no tables in it.
 *
 * Safe to run repeatedly, and it only ever touches the database named by
 * `DATABASE_URL`.
 */
export async function resetAndMigrate(): Promise<void> {
  await withTestPool(async (pool) => {
    await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
    await pool.query('CREATE SCHEMA public');

    await migrate(drizzle(pool), { migrationsFolder });
  });
}

/** Applies the committed migrations without dropping anything first. */
export async function applyMigrations(): Promise<void> {
  await withTestPool(async (pool) => {
    await migrate(drizzle(pool), { migrationsFolder });
  });
}

/**
 * Whether the migrated schema is present.
 *
 * Used by the global setup to decide between "migrate this database" and
 * "leave it alone"; a full reset on every run would be slower and would make
 * the suite destroy a developer's scratch data for no reason.
 */
export async function isSchemaPresent(): Promise<boolean> {
  return withTestPool(async (pool) => {
    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [[...EXPECTED_TABLES]],
    );

    return rows.length === EXPECTED_TABLES.length;
  });
}
