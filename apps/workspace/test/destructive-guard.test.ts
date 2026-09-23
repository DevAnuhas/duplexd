import { describe, expect, it } from "vitest"
import {
  ALLOW,
  destructiveRunRefusal,
  type DestructiveRunInput,
} from "./helpers/destructive-guard.ts"

/**
 * The guard that would have stopped 2026-09-22.
 *
 * It has exactly one job — refuse when the schema-dropping suite is pointed at
 * the database `.env.local` names — and three jobs it must *not* take on:
 * breaking CI, breaking a fresh clone, or refusing a deliberate opt-out.
 */

const EVIDENCE =
  "postgresql://u:p@ep-odd-fog-avsl774d.c-11.us-east-1.aws.neon.tech/neondb?sslmode=require"
const POOLED =
  "postgresql://u:p@ep-odd-fog-avsl774d-pooler.c-11.us-east-1.aws.neon.tech/neondb?sslmode=require"
const SCRATCH =
  "postgresql://u:p@ep-steep-salad-avnh4rl3.c-11.us-east-1.aws.neon.tech/neondb?sslmode=require"

function input(over: Partial<DestructiveRunInput> = {}): DestructiveRunInput {
  return {
    databaseUrl: EVIDENCE,
    envLocalUrl: EVIDENCE,
    continuousIntegration: false,
    allowed: false,
    ...over,
  }
}

describe("destructiveRunRefusal", () => {
  it("refuses the database .env.local names", () => {
    const refusal = destructiveRunRefusal(input())

    expect(refusal).not.toBeNull()
    // The person reading this at 1am should not have to open the script.
    expect(refusal).toContain("ep-odd-fog-avsl774d.c-11.us-east-1.aws.neon.tech")
    expect(refusal).toContain("/neondb")
    expect(refusal).toContain(ALLOW)
  })

  /**
   * The case a raw string comparison misses, and it misses it in the direction
   * that loses data: Neon serves the same database on `ep-x.…` and
   * `ep-x-pooler.…`, so a guard comparing connection strings would wave through
   * the pooled spelling of the very database it exists to protect.
   */
  it.each([
    ["pooled URL against a direct .env.local", POOLED, EVIDENCE],
    ["direct URL against a pooled .env.local", EVIDENCE, POOLED],
  ])("refuses a %s", (_label, databaseUrl, envLocalUrl) => {
    expect(destructiveRunRefusal(input({ databaseUrl, envLocalUrl }))).not.toBeNull()
  })

  it("permits a genuinely different database", () => {
    expect(
      destructiveRunRefusal(input({ databaseUrl: SCRATCH }))
    ).toBeNull()
  })

  it("permits the same host when the database differs", () => {
    expect(
      destructiveRunRefusal(
        input({ databaseUrl: EVIDENCE.replace("/neondb", "/scratchdb") })
      )
    ).toBeNull()
  })

  /**
   * CI's database is disposable and starts empty — `migrations.test.ts` exists
   * to prove migrations apply to an empty schema. A guard that fired here would
   * break the run it is protecting, on every job, forever.
   */
  it("never fires in CI, even pointed at the same database", () => {
    expect(
      destructiveRunRefusal(input({ continuousIntegration: true }))
    ).toBeNull()
  })

  it("permits a deliberate opt-out", () => {
    expect(destructiveRunRefusal(input({ allowed: true }))).toBeNull()
  })

  it.each([
    ["no DATABASE_URL at all", { databaseUrl: undefined }],
    ["an empty DATABASE_URL", { databaseUrl: "   " }],
    ["a fresh clone with no .env.local", { envLocalUrl: undefined }],
    ["an .env.local with no DATABASE_URL line", { envLocalUrl: "" }],
  ])("stays out of the way with %s", (_label, over) => {
    expect(destructiveRunRefusal(input(over))).toBeNull()
  })

  it("stays out of the way when a URL cannot be parsed", () => {
    // Unparseable means unidentifiable, and an unidentifiable database is not
    // evidence of the dangerous one. The suite's own connection error is a
    // better report than a refusal guessing at what it could not read.
    expect(
      destructiveRunRefusal(
        input({ databaseUrl: "not a url", envLocalUrl: "not a url" })
      )
    ).toBeNull()
  })
})
