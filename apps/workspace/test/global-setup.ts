import {
  databaseSkipReason,
  isContinuousIntegration,
  isDatabaseConfigured,
  loadTestEnvironment,
} from './helpers/environment.ts';
import { applyMigrations, isSchemaPresent } from './helpers/database.ts';

/**
 * Runs once before the suite, in the runner process.
 *
 * Two jobs. First, make sure a configured database has the migrated schema, so
 * every database-backed file finds its tables regardless of the order vitest
 * picks — `test/migrations.test.ts` resets the database itself and leaves it
 * migrated, so it is safe wherever it lands, but the files that run before it
 * still need the schema to exist.
 *
 * Second, say out loud what is about to happen. A run that skips its
 * database-backed tests must announce why; the failure this whole arrangement
 * guards against is a suite that quietly runs fewer tests than it did last week
 * and still prints green.
 */
/**
 * The files that skip without a database, named so the skip message says what
 * was not run rather than only how many things were not run.
 *
 * `test/database-gating.test.ts` is absent on purpose: it always runs, because
 * it is the file that polices this arrangement.
 */
export const DATABASE_BACKED_FILES = [
  'migrations',
  'cross-account-isolation',
  'secret-at-rest',
  'api-keys-schema',
  'signup-account',
  'account-resolver',
  // P03.
  'api-keys',
  'assistant-write-path',
  'cross-account-writes',
  'query-param-redaction',
  'server-secret-lifecycle',
] as const;

export default async function setup(): Promise<void> {
  loadTestEnvironment();

  if (!isDatabaseConfigured()) {
    if (isContinuousIntegration()) {
      // Belt to the braces in `test/database-gating.test.ts`: failing here as
      // well means a misconfigured CI job cannot even reach the suite.
      throw new Error(
        'CI is set but DATABASE_URL is not. Database-backed tests would skip ' +
          'in the one place that gates a merge, which would report green over ' +
          'unenforced cross-account isolation, migration and encryption tests.',
      );
    }

    console.warn(
      [
        '',
        `[workspace tests] Database-backed tests will SKIP: ${databaseSkipReason()}`,
        `[workspace tests] Skipping ${DATABASE_BACKED_FILES.length} files: ${DATABASE_BACKED_FILES.join(', ')}`,
        '[workspace tests] Set DATABASE_URL to a PostgreSQL 17+ connection string to run them.',
        '',
      ].join('\n'),
    );

    return;
  }

  // Deliberately unguarded. If DATABASE_URL is set and this throws — wrong
  // host, wrong credentials, unreachable database — the run fails. It never
  // downgrades to a skip, because a broken database that reports green is a
  // worse outcome than a broken database that reports red.
  if (!(await isSchemaPresent())) {
    await applyMigrations();
  }
}
