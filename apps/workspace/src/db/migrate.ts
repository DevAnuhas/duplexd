import { migrate } from 'drizzle-orm/node-postgres/migrator';

import { closeDb, getDb } from './client.ts';

/**
 * Applies committed migrations. Idempotent: Drizzle records what it has run in
 * `drizzle.__drizzle_migrations`, so a second run is a no-op rather than an
 * error.
 *
 * `getDb()` fails closed when `DATABASE_URL` is unset or empty, so this script
 * cannot silently migrate a local database that happened to be listening.
 */
async function main(): Promise<void> {
  await migrate(getDb(), { migrationsFolder: 'drizzle' });
  await closeDb();
  console.log('migrations applied');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
