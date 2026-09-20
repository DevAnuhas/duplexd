import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"

/**
 * Test environment loading and the one rule that decides whether a
 * database-backed test may skip.
 *
 * The skip rule is the part worth reading twice. It is keyed to **no database
 * being configured at all**, and to nothing else. A suite that skips because a
 * connection failed turns a broken CI service container into a green run, which
 * is strictly worse than having no test: the invariant stops being enforced and
 * nobody is told. So if `DATABASE_URL` is set and the database is unreachable,
 * wrong, or unmigratable, that surfaces as a **test failure**.
 */

/** The repository root, four levels up from `apps/workspace/test/helpers/`. */
const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url))
const workspaceRoot = fileURLToPath(new URL("../../", import.meta.url))

/**
 * Obviously-fake defaults so the non-database tests run in a fresh clone with
 * no `.env.local` and no environment variables at all.
 *
 * These are never a fallback for production: `src/db/env.ts` has no defaults,
 * and nothing here is imported by application code. A real key would not belong
 * in the repository, and a test that needed one would be a test that could not
 * run on a new machine.
 */
const TEST_ONLY_DEFAULTS: Readonly<Record<string, string>> = {
  BETTER_AUTH_SECRET: "test-only-placeholder-not-a-real-better-auth-secret",
  BETTER_AUTH_URL: "http://localhost:3000",
  ASSISTANT_SECRET_KEY:
    "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
  PIPECAT_API_KEY: "test-only-placeholder-not-a-real-pipecat-key",
  CALL_SWEEP_TOKEN: "test-only-placeholder-not-a-real-sweep-token",
}

/**
 * Loads `.env.local` from the repository root when it exists, then fills in the
 * test-only defaults for anything still unset.
 *
 * `DATABASE_URL` is deliberately **not** defaulted. A default would mean a
 * machine with no configured database silently pointed the suite at whatever
 * PostgreSQL happened to be listening locally — the exact failure mode
 * `requireDatabaseUrl` exists to prevent.
 *
 * `process.loadEnvFile` does not overwrite a variable that is already set, even
 * one set to the empty string. So the environment beats the file, which is both
 * the behaviour every dotenv loader has and the reason `DATABASE_URL= pnpm test`
 * reproduces a fresh clone's skip path on a machine that does have a
 * `.env.local`.
 */
export function loadTestEnvironment(): void {
  // Next's conventional location is the package directory. The root fallback
  // preserves older worktrees. `loadEnvFile` never overwrites an existing
  // value, so the process environment still wins and the first file wins over
  // the fallback.
  for (const envLocal of [
    `${workspaceRoot}.env.local`,
    `${repositoryRoot}.env.local`,
  ]) {
    if (existsSync(envLocal)) {
      process.loadEnvFile(envLocal)
    }
  }

  for (const [name, value] of Object.entries(TEST_ONLY_DEFAULTS)) {
    if ((process.env[name] ?? "") === "") {
      process.env[name] = value
    }
  }
}

/**
 * Just the variables these predicates read.
 *
 * Narrower than `NodeJS.ProcessEnv` so a test can pass a literal `{}` to mean
 * "nothing is set" without also having to invent a `NODE_ENV`.
 */
export type EnvironmentLike = Readonly<Record<string, string | undefined>>

/**
 * Whether a database is configured at all.
 *
 * Pure and synchronous on purpose: it inspects configuration and never opens a
 * connection. The moment this function tries to reach the database, "skip"
 * starts meaning "unreachable" as well as "unconfigured", and the hole this
 * whole module exists to close reopens.
 */
export function isDatabaseConfigured(
  env: EnvironmentLike = process.env
): boolean {
  return (env.DATABASE_URL ?? "").trim() !== ""
}

/** Whether the suite is running in CI, where skipping is itself a failure. */
export function isContinuousIntegration(
  env: EnvironmentLike = process.env
): boolean {
  return (env.CI ?? "") !== ""
}

/**
 * The reason database-backed tests are skipping, or `null` when they are not.
 *
 * Printed once by the global setup so a skipped run says why, rather than
 * quietly reporting fewer tests than the last one.
 */
export function databaseSkipReason(
  env: EnvironmentLike = process.env
): string | null {
  if (isDatabaseConfigured(env)) {
    return null
  }

  return "DATABASE_URL is not set, so no database is configured."
}
