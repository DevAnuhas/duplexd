import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  databaseSkipReason,
  isContinuousIntegration,
  isDatabaseConfigured,
} from './helpers/environment.ts';
import { withTestPool } from './helpers/database.ts';
import { DATABASE_BACKED_FILES } from './global-setup.ts';

/**
 * The tests that guard the skip.
 *
 * Skipping is the defect this file exists to prevent, not the missing database.
 * A suite that skips its cross-account isolation, migration and encryption-at-
 * rest tests and still prints green is worse than one that fails: the
 * invariants stop being enforced and nobody is told.
 *
 * Two rules, one test each.
 */

describe('database-backed tests may only skip when no database is configured', () => {
  /**
   * Rule one. The skip predicate looks at configuration and nothing else.
   *
   * The second case is the whole point: a `DATABASE_URL` pointing at an address
   * that cannot possibly answer must still count as configured. If someone
   * "helpfully" makes the predicate probe the connection, a broken CI service
   * container starts reporting green, and this assertion is what stops that
   * landing.
   */
  it.each([
    ['a real-looking connection string', 'postgres://user:pw@db.example:5432/x'],
    ['an unroutable address', 'postgres://user:pw@203.0.113.1:5432/x'],
    ['a local server', 'postgres://localhost:5432/x'],
  ])('treats %s as configured', (_label, url) => {
    expect(isDatabaseConfigured({ DATABASE_URL: url })).toBe(true);
    expect(databaseSkipReason({ DATABASE_URL: url })).toBeNull();
  });

  it.each([
    ['unset', {}],
    ['the empty string', { DATABASE_URL: '' }],
    ['only whitespace', { DATABASE_URL: '   ' }],
  ])('treats %s as not configured', (_label, env) => {
    expect(isDatabaseConfigured(env)).toBe(false);
    expect(databaseSkipReason(env)).toMatch(/DATABASE_URL/);
  });
});

/**
 * Rule two. In CI the skip path is unreachable, and this asserts it is.
 *
 * `isDatabaseConfigured()` is the only input to every `skipIf` in this suite,
 * so proving it is true here proves no database-backed test skipped. The round
 * trip is the second half: configured-but-unreachable would satisfy the
 * predicate, so the connection is actually made, and a failure to make it fails
 * the run rather than reducing it to a skip.
 */
describe('CI', () => {
  it.runIf(isContinuousIntegration())(
    'has a reachable database, so no database-backed test skipped',
    async () => {
      expect(
        isDatabaseConfigured(),
        'CI must set DATABASE_URL. Without it the cross-account isolation, ' +
          'migration and encryption-at-rest tests would skip in the one place ' +
          'that gates a merge.',
      ).toBe(true);

      const answer = await withTestPool(async (pool) => {
        const { rows } = await pool.query<{ ok: number }>('SELECT 1 AS ok');

        return rows[0]?.ok;
      });

      expect(answer).toBe(1);
    },
  );

  it.skipIf(isContinuousIntegration())(
    'is not set, so a missing database is allowed to skip locally',
    () => {
      expect(isContinuousIntegration()).toBe(false);
    },
  );
});

/**
 * The skip message names the files it is skipping, and that list is written by
 * hand. This keeps it honest: a new database-backed file that nobody added to
 * the list would make a skipped run under-report what it did not check, which is
 * a quieter version of the same failure.
 */
describe('the skip message', () => {
  it('names exactly the files that skip without a database', () => {
    const directory = fileURLToPath(new URL('.', import.meta.url));

    // This file is excluded because it carries the pattern as a string literal
    // in the line below, and would otherwise always match itself.
    const self = 'database-gating.test.ts';
    const marker = 'describe.skipIf(!isDatabaseConfigured())';

    const skipping = readdirSync(directory)
      .filter((name) => name.endsWith('.test.ts') && name !== self)
      .filter((name) => readFileSync(`${directory}${name}`, 'utf8').includes(marker))
      .map((name) => name.replace(/\.test\.ts$/, ''))
      .sort();

    expect(skipping).toStrictEqual([...DATABASE_BACKED_FILES].sort());
  });
});
