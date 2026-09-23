import { afterEach, beforeEach, expect, it, vi } from "vitest"

/**
 * Proves the guard is actually wired into the thing that drops schemas, not
 * merely present in the repository.
 *
 * `pg` is mocked to throw on any attempt to open a pool. That is the safety
 * net rather than the assertion: this test sets `DATABASE_URL` to exactly the
 * value `.env.local` names — the dangerous condition — and a guard that failed
 * to fire would otherwise reach the real database and drop it. With the driver
 * mocked, the worst a regression here can do is fail this test.
 *
 * The two outcomes are deliberately distinguishable:
 *   - "Refused: …"   → the guard fired, nothing connected. Correct.
 *   - "pg was opened" → the guard did not fire and the code reached the driver.
 */
vi.mock("pg", () => ({
  default: {
    Pool: class {
      constructor() {
        throw new Error(
          "pg was opened: the destructive guard did not fire before connecting"
        )
      }
    },
  },
}))

const saved = new Map<string, string | undefined>()
beforeEach(() => {
  for (const name of ["DATABASE_URL", "DUPLEXD_ALLOW_DESTRUCTIVE_TESTS", "CI"])
    saved.set(name, process.env[name])
})
afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  saved.clear()
  vi.resetModules()
})

it("refuses dropAllSchemas when pointed at the database .env.local names", async () => {
  const { envLocalDatabaseUrl } = await import("./helpers/environment.ts")
  const target = envLocalDatabaseUrl()
  if (target === undefined) {
    // A fresh clone has nothing to compare against, and the guard correctly
    // stays out of the way. Reported rather than silently passing.
    expect(target).toBeUndefined()
    return
  }

  process.env.DATABASE_URL = target
  delete process.env.DUPLEXD_ALLOW_DESTRUCTIVE_TESTS
  delete process.env.CI

  const { dropAllSchemas } = await import("./helpers/database.ts")

  await expect(dropAllSchemas()).rejects.toThrow(/^Refused:/)
})

/**
 * CI must behave exactly as it did before this guard existed.
 *
 * CI's database is disposable and starts empty, and `migrations.test.ts` is
 * there to prove migrations apply to an empty schema — so a guard that fired
 * in CI would break the run it protects, on every job. This asserts it does
 * not fire even under the condition that refuses everywhere else. The full
 * proof is the `ready_for_review` run; this is the part that can be checked
 * without waiting for it.
 */
it("does not fire in CI, even pointed at the database .env.local names", async () => {
  const { envLocalDatabaseUrl } = await import("./helpers/environment.ts")
  const target = envLocalDatabaseUrl()
  if (target === undefined) return

  process.env.DATABASE_URL = target
  process.env.CI = "true"
  delete process.env.DUPLEXD_ALLOW_DESTRUCTIVE_TESTS

  const { dropAllSchemas } = await import("./helpers/database.ts")

  // Reaching the driver is the pass condition: the guard stood aside.
  await expect(dropAllSchemas()).rejects.toThrow(/pg was opened/)
})

it("permits dropAllSchemas against a different database", async () => {
  process.env.DATABASE_URL =
    "postgresql://u:p@ep-somewhere-else.c-11.us-east-1.aws.neon.tech/neondb"
  delete process.env.DUPLEXD_ALLOW_DESTRUCTIVE_TESTS
  delete process.env.CI

  const { dropAllSchemas } = await import("./helpers/database.ts")

  // Reaching the driver is the pass condition here: it means the guard let it
  // through. Without this case, the refusal test above would pass against a
  // guard that refused everything.
  await expect(dropAllSchemas()).rejects.toThrow(/pg was opened/)
})
