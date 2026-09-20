import { beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations as applyApplicationMigrations } from '@/db/migrate';

import { EXPECTED_TABLES, withTestPool } from './helpers/database.ts';
import { isDatabaseConfigured } from './helpers/environment.ts';

/**
 * Migrations from a genuinely empty database, and idempotent on a second run.
 *
 * **This file drops and recreates schemas.** It only ever touches the database
 * named by `DATABASE_URL`, through the same `requireDatabaseUrl()` guard the
 * application uses, so it cannot reach a local default. `vitest.config.ts`
 * disables file parallelism specifically so this cannot run alongside another
 * database-backed file and delete the rows it is asserting about.
 *
 * "Empty" is the contract's definition: `public` dropped and recreated **and**
 * the `drizzle` schema holding `__drizzle_migrations` dropped. Dropping only
 * `public` would leave the ledger behind, `migrate()` would conclude it had
 * already run everything, and this suite would happily verify a database with
 * no tables in it.
 */

type IndexRow = { indexname: string; indexdef: string };

const describeDatabase = describe.skipIf(!isDatabaseConfigured());

describeDatabase('migrations from an empty database', () => {
  let indexes: IndexRow[] = [];
  let tables: string[] = [];
  let firstReport = { before: -1, after: -1, applied: -1 };

  beforeAll(async () => {
    // Unguarded on purpose. If DATABASE_URL is set and this fails, the run
    // fails; it never downgrades to a skip.
    await withTestPool(async (pool) => {
      await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
      await pool.query('CREATE SCHEMA public');
    });
    firstReport = await applyApplicationMigrations();

    ({ indexes, tables } = await withTestPool(async (pool) => {
      const tableRows = await pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
         ORDER BY table_name`,
      );
      const indexRows = await pool.query<IndexRow>(
        `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'`,
      );

      return {
        tables: tableRows.rows.map((row) => row.table_name),
        indexes: indexRows.rows,
      };
    }));
  });

  it('creates every table in the data model', () => {
    for (const table of EXPECTED_TABLES) {
      expect(tables, `missing table: ${table}`).toContain(table);
    }
  });

  it('creates no table the data model does not name', () => {
    expect([...tables].sort()).toStrictEqual([...EXPECTED_TABLES].sort());
  });

  it('records the migration in the drizzle ledger', async () => {
    const applied = await withTestPool(async (pool) => {
      const { rows } = await pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations',
      );

      return Number(rows[0]?.count ?? 0);
    });

    expect(applied).toBeGreaterThan(0);
    expect(firstReport).toStrictEqual({
      before: 0,
      after: applied,
      applied,
    });
  });

  describe('indexes from the data model', () => {
    function definitionOf(name: string): string {
      const found = indexes.find((row) => row.indexname === name);

      expect(found, `missing index: ${name}`).toBeDefined();

      return found?.indexdef ?? '';
    }

    it('indexes api_keys (prefix) uniquely', () => {
      expect(definitionOf('api_keys_prefix_idx')).toMatch(
        /CREATE UNIQUE INDEX/i,
      );
      expect(definitionOf('api_keys_prefix_idx')).toMatch(/\(prefix\)/i);
    });

    it('indexes calls (account_id, created_at desc)', () => {
      const definition = definitionOf('calls_account_created_idx');

      expect(definition).toMatch(/account_id/);
      expect(definition).toMatch(/created_at DESC/i);
    });

    it('indexes calls by API key for attribution checks and foreign-key maintenance', () => {
      expect(definitionOf('calls_api_key_idx')).toMatch(/\(api_key_id\)/i);
    });

    it('indexes calls (state) partially, for active calls only', () => {
      const definition = definitionOf('calls_active_idx');

      expect(definition).toMatch(/\(state\)/i);
      expect(definition).toMatch(/WHERE .*state = 'active'/i);
    });

    it('indexes starting calls separately for expiry sweeps', () => {
      const definition = definitionOf('calls_starting_idx');

      expect(definition).toMatch(/\(state\)/i);
      expect(definition).toMatch(/WHERE .*state = 'starting'/i);
    });

    it('requires each stored agent-token digest to identify one call', () => {
      const definition = definitionOf('calls_agent_token_hash_idx');

      expect(definition).toMatch(/CREATE UNIQUE INDEX/i);
      expect(definition).toMatch(/\(agent_token_hash\)/i);
    });

    it('gives call_events a composite primary key on (call_id, seq)', async () => {
      const key = await withTestPool(async (pool) => {
        const { rows } = await pool.query<{ column_name: string }>(
          `SELECT a.attname AS column_name
           FROM pg_constraint c
           JOIN pg_class t ON t.oid = c.conrelid
           JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON TRUE
           JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
           WHERE t.relname = 'call_events' AND c.contype = 'p'
           ORDER BY k.ord`,
        );

        return rows.map((row) => row.column_name);
      });

      expect(key).toStrictEqual(['call_id', 'seq']);
    });
  });

  /**
   * The second run. Drizzle records what it has applied, so this must be a
   * no-op rather than an error — a deploy that ran migrations twice would
   * otherwise fail the second time and take the release with it.
   */
  it('is idempotent on a second run, with no change to the schema', async () => {
    const before = await snapshot();

    const second = await applyApplicationMigrations();

    expect(second.applied).toBe(0);
    expect(second.after).toBe(second.before);

    expect(await snapshot()).toStrictEqual(before);
  });
});

/** Tables, columns and indexes, as a comparable shape. */
async function snapshot(): Promise<{
  columns: string[];
  indexes: string[];
  migrations: number;
}> {
  return withTestPool(async (pool) => {
    const columns = await pool.query<{ signature: string }>(
      `SELECT table_name || '.' || column_name || ':' || data_type ||
              ':' || is_nullable AS signature
       FROM information_schema.columns
       WHERE table_schema = 'public'
       ORDER BY signature`,
    );
    const indexes = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexdef`,
    );
    const migrations = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations',
    );

    return {
      columns: columns.rows.map((row) => row.signature),
      indexes: indexes.rows.map((row) => row.indexdef),
      migrations: Number(migrations.rows[0]?.count ?? 0),
    };
  });
}
