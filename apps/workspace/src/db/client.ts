import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { requireDatabaseUrl } from './env.ts';
import { withRedactedQueryErrors } from './redact.ts';
import * as schema from './schema.ts';

/**
 * The database client, created on first use rather than at module import.
 *
 * Imports within `src/db/` are relative with explicit `.ts` extensions rather
 * than using the `@/` alias, because `src/db/migrate.ts` runs under plain Node
 * (`--experimental-strip-types`) where the alias does not exist. Application
 * code, which Next bundles, uses `@/` as normal.
 *
 * Laziness is load-bearing, not style. `next build` imports every module it
 * traces; if the pool were constructed at import, the production build would
 * require `DATABASE_URL` to be set and the database to be reachable from the
 * builder. That would make every future deploy depend on the database being
 * visible from CI, which is the thing issue #25 explicitly rules out.
 */

let pool: Pool | undefined;
let db: ReturnType<typeof drizzle<typeof schema>> | undefined;

export function getDb(): ReturnType<typeof drizzle<typeof schema>> {
  if (db === undefined) {
    pool = new Pool({ connectionString: requireDatabaseUrl() });
    // Wrapped here so every caller is covered, including Better Auth's
    // adapter, which receives this same client and cannot opt in itself.
    db = withRedactedQueryErrors(drizzle(pool, { schema }));
  }

  return db;
}

/** Closes the pool. Tests use this; the server does not need it. */
export async function closeDb(): Promise<void> {
  if (pool !== undefined) {
    await pool.end();
    pool = undefined;
    db = undefined;
  }
}
