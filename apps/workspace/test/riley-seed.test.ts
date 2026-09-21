import { describe, expect, it, vi } from "vitest"

import { assistantSchema } from "@/lib/assistant-schema"
import { summarizeTools } from "@/lib/tools-summary"
import { validateServerUrl, validateTools } from "@/lib/validate"

/**
 * The Riley demo seed, everything that does not need a database.
 *
 * `test/riley-seed-database.test.ts` covers the insert. This file covers the
 * two things a seed script gets wrong in ways nobody notices until someone runs
 * it against production data:
 *
 *  1. **The preview must not connect.** `pnpm seed:riley` with no flags is the
 *     command a reader runs to see what the script would do. If it opens a
 *     connection it has already required `DATABASE_URL`, and "preview" has
 *     stopped meaning what the help text says it means.
 *  2. **The configuration must be savable by the editor that owns it.** The
 *     seed writes assistant rows directly. A row the workspace form cannot
 *     re-save is a demo the customer can look at and not edit — and the way
 *     that happens is a tool list in a shape the shared validator rejects,
 *     which is exactly what the first draft of this seed shipped: tools wrapped
 *     as `{type: "function", function: {…}}` where `validateTools` wants
 *     `{name, description, parameters}`. The assertion below is against the
 *     shared validator rather than against a shape written out here, because a
 *     literal copy of the expected shape would have agreed with the broken
 *     draft.
 *
 * The database module is mocked with a `getDb` that throws and counts. Counting
 * is what makes "the preview did not connect" mean something: the apply case at
 * the bottom calls the same mock and expects the count to go up, so a seed that
 * stopped connecting entirely fails there rather than passing everywhere.
 */

const database = vi.hoisted(() => ({ getDb: 0, closeDb: 0 }))

vi.mock("../src/db/client.ts", () => ({
  getDb: () => {
    database.getDb += 1
    throw new Error("canary: the seed opened a database connection")
  },
  closeDb: async () => {
    database.closeDb += 1
  },
}))

const { main, parseSeedArgs, validatedRileyDemo } =
  await import("../scripts/seed-riley.ts")
const { rileyDemo, rileyDemoId } = await import("../scripts/riley-demo.ts")

/** The message a throwing call carried, so two rules can be told apart. */
function messageFrom(body: () => unknown): string {
  try {
    body()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }

  throw new Error("Expected the call to throw, and it did not.")
}

/** Runs `main`, returning what it printed, with the connection counters reset. */
async function runMain(args: string[]): Promise<string[]> {
  database.getDb = 0
  database.closeDb = 0

  const lines: string[] = []
  const log = vi.spyOn(console, "log").mockImplementation((...parts) => {
    lines.push(parts.map(String).join(" "))
  })

  try {
    await main(args)
  } finally {
    log.mockRestore()
  }

  return lines
}

describe("the argument parser", () => {
  it("defaults to a preview with no owner", () => {
    expect(parseSeedArgs([])).toStrictEqual({
      apply: false,
      help: false,
      ownerEmail: undefined,
    })
  })

  it("normalizes the owner email, so casing in a shell cannot miss the user", () => {
    expect(
      parseSeedArgs(["--apply", "--owner-email", "  Owner@Example.COM "])
    ).toStrictEqual({
      apply: true,
      help: false,
      ownerEmail: "owner@example.com",
    })
  })

  /**
   * An owner without `--apply` is refused rather than ignored. Silently
   * previewing it is the dangerous reading: the operator typed an email,
   * watched a wall of JSON scroll past, and has no way to tell that nothing was
   * written — so the next thing they do is assume the workspace has a demo in
   * it.
   */
  it("refuses an owner without --apply instead of quietly previewing", () => {
    expect(() =>
      parseSeedArgs(["--owner-email", "owner@example.invalid"])
    ).toThrow()

    const message = messageFrom(() =>
      parseSeedArgs(["--owner-email", "owner@example.invalid"])
    )

    // Its own rule, not the parser's catch-all: the usage line would also
    // mention both flags, so distinctness from it is the assertion.
    expect(message).toMatch(/--owner-email/)
    expect(message).toMatch(/--apply/)
    expect(message).not.toMatch(/^Usage: pnpm seed:riley/)
  })

  /**
   * Both rejections below are asserted by **which** message they carry, not
   * merely that they threw. The two rules fail for different reasons and want
   * different fixes — "you forgot a flag" against "that flag does not exist" —
   * and a test that only counted throws would pass if either rule swallowed the
   * other.
   */
  it.each([
    ["no owner at all", ["--apply"]],
    ["an empty owner", ["--apply", "--owner-email", ""]],
    ["an owner of only whitespace", ["--apply", "--owner-email", "   "]],
  ])("rejects --apply with %s, naming the missing flag", (_label, args) => {
    expect(() => parseSeedArgs(args)).toThrow(/--apply requires --owner-email/)
  })

  it.each([
    ["an unknown flag", ["--force"]],
    ["a misspelled owner flag", ["--apply", "--ownerEmail", "a@b.invalid"]],
    ["an owner flag with no value", ["--apply", "--owner-email"]],
    ["a positional argument", ["apply"]],
  ])("rejects %s with the usage message", (_label, args) => {
    expect(() => parseSeedArgs(args)).toThrow(/Usage: pnpm seed:riley/)
  })

  it.each([["--help"], ["-h"]])("accepts %s", (flag) => {
    expect(parseSeedArgs([flag]).help).toBe(true)
  })

  it("lets --help past the owner requirement, so help never fails", () => {
    expect(() => parseSeedArgs(["--help", "--apply"])).not.toThrow()
    expect(parseSeedArgs(["--help", "--apply"]).help).toBe(true)
  })
})

describe("the demo configuration", () => {
  /**
   * The regression that shipped in the first draft. Against the shared
   * validator, not against a shape restated here: the broken draft was
   * internally consistent, so only the validator the write path actually uses
   * can tell the two apart.
   */
  it("passes the same validator the write path uses", () => {
    expect(validateTools(rileyDemo().tools)).toStrictEqual([])
  })

  /**
   * Preview and apply validate through the same function, so the preview
   * cannot show a configuration the apply would reject. Asserting it returns
   * the configuration unchanged is what stops the gate turning into a
   * normalizer that quietly rewrites what the reader was shown.
   */
  it("is gated by one validator shared with the preview", () => {
    expect(validatedRileyDemo()).toStrictEqual(rileyDemo())
  })

  /**
   * The other half of that shared validation. `null` is the disconnected state
   * and the validator has to accept it; a validator that rejected it would make
   * the demo unseedable, and the second case is there so "accepts null" cannot
   * be satisfied by a validator that accepts everything.
   */
  it("passes the shared server-URL validator, which accepts disconnected", () => {
    expect(validateServerUrl(rileyDemo().serverUrl)).toBeNull()
    expect(validateServerUrl("http://192.168.0.1/hook")).not.toBeNull()
  })

  it("summarizes for the editor, naming its one tool", () => {
    const summary = summarizeTools(JSON.stringify(rileyDemo().tools))

    expect(summary).toStrictEqual({
      ok: true,
      rows: [
        {
          name: "get_property_information",
          description: expect.stringContaining("non-sensitive"),
          parameterCount: 2,
        },
      ],
    })
  })

  /**
   * The round trip. A seeded row is edited through the workspace form, so the
   * form's schema has to accept what the seed wrote — including the name length
   * rule, which a long demo title would quietly break.
   */
  it("round-trips through the editor's form schema", () => {
    const config = rileyDemo()
    const parsed = assistantSchema.safeParse({
      name: config.name,
      instructions: config.instructions,
      voice: config.voice,
      accentStyle: config.accentStyle,
      waitingBehavior: config.waitingBehavior,
      backendModel: config.backendModel,
      backendInstructions: config.backendInstructions,
      serverUrl: config.serverUrl ?? "",
      serverSecret: "",
      clearServerSecret: false,
      tools: JSON.stringify(config.tools, null, 2),
    })

    expect(parsed.error?.issues).toBeUndefined()
    expect(parsed.success).toBe(true)
  })

  it("is disconnected: no webhook, no secret, no credential material", () => {
    const config = rileyDemo()

    expect(config.serverUrl).toBeNull()
    expect(Object.keys(config)).not.toContain("serverSecret")
    expect(Object.keys(config)).not.toContain("serverSecrets")

    // A URL anywhere in the configuration would be a live integration point
    // arriving through the back door, whatever the `serverUrl` column says.
    expect(JSON.stringify(config)).not.toMatch(/https?:\/\//)
    expect(JSON.stringify(config)).not.toMatch(
      /"[^"]*(secret|token|password|api[_-]?key)[^"]*"\s*:/i
    )
  })

  it("hands every caller its own object, so one edit cannot leak into the next", () => {
    const first = rileyDemo()
    const second = rileyDemo()

    expect(first).toStrictEqual(second)
    expect(first).not.toBe(second)

    first.name = "mutated"
    first.tools.length = 0

    expect(rileyDemo().name).toBe(second.name)
    expect(rileyDemo().tools).toHaveLength(1)
  })
})

describe("the demo identifier", () => {
  const account = "acct_01HR8Q2Z9K4M6P8S0V2X4Z6A8C"

  it("is stable for an account, which is what makes a rerun idempotent", () => {
    expect(rileyDemoId(account)).toBe(rileyDemoId(account))
    expect(rileyDemoId(account)).toMatch(/^riley-demo-[0-9a-f]{32}$/)
  })

  it("differs per account, so two accounts cannot collide on one row", () => {
    expect(rileyDemoId(account)).not.toBe(rileyDemoId(`${account}-other`))
  })

  it("does not carry the account id in the clear", () => {
    expect(rileyDemoId(account)).not.toContain(account)
  })
})

describe("the command line", () => {
  it("previews without connecting to a database", async () => {
    const lines = await runMain([])

    expect(database.getDb).toBe(0)
    expect(database.closeDb).toBe(0)
    expect(lines).toHaveLength(1)

    const preview = JSON.parse(lines[0]!) as Record<string, unknown>

    expect(preview.mode).toBe("preview")
    expect(preview.connected).toBe(false)
    expect(preview.assistant).toStrictEqual(rileyDemo())
    expect(String(preview.note)).toMatch(/no Boring Host integration/i)
  })

  it("prints help without connecting to a database", async () => {
    const lines = await runMain(["--help"])

    expect(database.getDb).toBe(0)
    expect(lines.join("\n")).toMatch(/seed:riley --apply --owner-email/)
    expect(lines.join("\n")).toMatch(/preview, no database connection/)
  })

  it("rejects --apply without an owner before opening a connection", async () => {
    await expect(runMain(["--apply"])).rejects.toThrow(
      /--apply requires --owner-email/
    )

    expect(database.getDb).toBe(0)
  })

  /**
   * The control for the three cases above. They assert a connection was *not*
   * opened, which a seed that never connects at all would also satisfy; this
   * asserts the same mocked `getDb` is reached on the one path that is supposed
   * to reach it, and that the pool is closed even when the work throws.
   */
  it("does connect on --apply, and closes the pool when it fails", async () => {
    await expect(
      runMain(["--apply", "--owner-email", "owner@example.invalid"])
    ).rejects.toThrow(/canary: the seed opened a database connection/)

    expect(database.getDb).toBe(1)
    expect(database.closeDb).toBe(1)
  })
})
