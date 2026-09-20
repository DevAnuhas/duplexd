import { fileURLToPath, pathToFileURL } from 'node:url';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

import { requireDatabaseUrl } from './env.ts';

/**
 * Applies committed migrations. Idempotent: Drizzle records what it has run in
 * `drizzle.__drizzle_migrations`, so a second run is a no-op rather than an
 * error.
 *
 * `getDb()` fails closed when `DATABASE_URL` is unset or empty, so this script
 * cannot silently migrate a local database that happened to be listening.
 */
const migrationsFolder = fileURLToPath(
  new URL('../../drizzle', import.meta.url),
);

export type MigrationReport = {
  before: number;
  after: number;
  applied: number;
};

async function migrationCount(pool: Pool): Promise<number> {
  const relation = await pool.query<{ ledger: string | null }>(
    `SELECT to_regclass('drizzle.__drizzle_migrations')::text AS ledger`,
  );
  if (relation.rows[0]?.ledger === null) return 0;

  const result = await pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations',
  );
  return Number(result.rows[0]?.count ?? 0);
}

/** Applies committed migrations and measures the ledger before and after. */
export async function applyMigrations(
  connectionString = requireDatabaseUrl(),
): Promise<MigrationReport> {
  const pool = new Pool({ connectionString, max: 1 });
  try {
    const before = await migrationCount(pool);
    await migrate(drizzle(pool), { migrationsFolder });
    const after = await migrationCount(pool);
    return { before, after, applied: after - before };
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const report = await applyMigrations();
  console.log(
    `migrations applied=${report.applied} ledger_before=${report.before} ledger_after=${report.after}`,
  );
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'migration failed');
    process.exitCode = 1;
  });
}
