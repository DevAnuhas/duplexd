/**
 * Refuses to run the schema-dropping suite against a developer's own database.
 *
 * On 2026-09-22 three separate agents were instructed to run this suite and
 * none of them checked what it does until the fourth attempt. `migrations.test`
 * runs `DROP SCHEMA public CASCADE`, and `loadTestEnvironment()` fills
 * `DATABASE_URL` from `apps/workspace/.env.local` — the running app's own file.
 * Running it as instructed would have destroyed the first real call evidence
 * this project ever produced: the only recording of a human speaking to the
 * assistant and being answered.
 *
 * Nothing in the repository prevented that, which is why this exists.
 *
 * The rule is narrow on purpose:
 *
 *  - **In CI it never fires.** CI's database is disposable and starts empty —
 *    `migrations.test` exists precisely to prove migrations apply to an empty
 *    schema. A guard that fired there would break the run it is protecting, on
 *    every job, forever. Keying on the existing CI predicate also means no
 *    workflow edit and no new secret, so the guard cannot itself turn CI red.
 *  - **A fresh clone is unaffected.** No `.env.local` means nothing to compare,
 *    and with no `DATABASE_URL` the database-backed files skip anyway.
 *  - **Only one case changes:** pointing the suite at the database your own
 *    `.env.local` names. That is the hazard, and it now takes one deliberate
 *    opt-out rather than one absent-minded `pnpm test`.
 */

import {
  envLocalDatabaseUrl,
  isContinuousIntegration,
} from "./environment.ts"

export const ALLOW = "DUPLEXD_ALLOW_DESTRUCTIVE_TESTS"

/**
 * Called by the operation that drops schemas, not by the runner.
 *
 * Guarding the whole run was the first shape of this and it was wrong: it
 * refused every local `pnpm test`, including files that never touch a
 * database, so the opt-out would have become something a developer exports
 * once and never thinks about again — a guard trained into decoration. This
 * fires on the destructive act itself, so everything else runs untouched.
 */
export function assertDestructiveAllowed(): void {
  const refusal = destructiveRunRefusal({
    databaseUrl: process.env.DATABASE_URL,
    envLocalUrl: envLocalDatabaseUrl(),
    continuousIntegration: isContinuousIntegration(),
    allowed: (process.env[ALLOW] ?? "") !== "",
  })
  if (refusal !== null) throw new Error(refusal)
}

/**
 * Host and database, with the pooled spelling folded into the direct one.
 *
 * Neon serves the same database as `ep-x.…` and `ep-x-pooler.…`. Comparing raw
 * connection strings would miss that, and miss it in the direction that loses
 * data — so the guard would wave through the pooled URL of the very database it
 * is meant to protect.
 */
function identity(url: string): string | null {
  try {
    const parsed = new URL(url)
    const [first = "", ...rest] = parsed.hostname.split(".")
    const host = [first.replace(/-pooler$/, ""), ...rest].join(".")
    return `${host}${parsed.pathname}`
  } catch {
    return null
  }
}

export type DestructiveRunInput = {
  databaseUrl: string | undefined
  envLocalUrl: string | undefined
  continuousIntegration: boolean
  allowed: boolean
}

/** The refusal to print, or `null` when the run may proceed. */
export function destructiveRunRefusal({
  databaseUrl,
  envLocalUrl,
  continuousIntegration,
  allowed,
}: DestructiveRunInput): string | null {
  if (continuousIntegration || allowed) return null
  if (!databaseUrl?.trim() || !envLocalUrl?.trim()) return null

  const target = identity(databaseUrl)
  if (target === null || target !== identity(envLocalUrl)) return null

  return [
    `Refused: this suite drops and recreates \`public\` on ${target}, which is the`,
    `database \`apps/workspace/.env.local\` points at. Everything in it is lost.`,
    ``,
    `Run it against a scratch database instead:`,
    `  DATABASE_URL=<scratch> pnpm test`,
    ``,
    `Or, if wiping that database is genuinely what you want:`,
    `  ${ALLOW}=1 pnpm test`,
  ].join("\n")
}
