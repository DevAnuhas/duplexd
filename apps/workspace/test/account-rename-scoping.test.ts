import { randomUUID } from "node:crypto"

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import type { SignedUpUser } from "./helpers/auth.ts"

/**
 * `renameAccountAction` — the account's only write surface, and the first one
 * whose scope a submitted form could plausibly be asked to choose.
 *
 * The property under test is not "renaming works". It is that **the row the
 * rename lands on comes from the server-side session and from nothing else**.
 * A rename is the write nobody thinks to review — it looks harmless in a diff —
 * so the test that matters is the hostile one below: act as the first account
 * and submit a `FormData` that names the *second* account in every field a
 * caller might hope is read, then assert the second account's name is still
 * exactly what it was. A happy-path test would stay green on the day the action
 * starts trusting a form field; this one goes red.
 *
 * Every rejection is asserted on the **post-state**, not on the return value.
 * Not "it returned `ok: false`" but "the stored name is unchanged". An action
 * that reported a rejection and wrote anyway satisfies the first and fails the
 * second, and the second is what the customer experiences.
 *
 * Two things are mocked, neither of them the subject: `next/headers`, which
 * needs a request scope a test process does not have, and `next/cache`, whose
 * `revalidatePath` needs the same. The session those headers carry is real, the
 * signup that minted it is real, the database is real, and the account the
 * action resolves is the real resolver's answer. Mocking the session or the
 * data layer would leave a test that asserts a stub returned what the stub was
 * told to return.
 */

const requestHeaders = { current: new Headers() }

vi.mock("next/headers", () => ({
  headers: async () => requestHeaders.current,
}))

const revalidatePath = vi.fn()

vi.mock("next/cache", () => ({
  revalidatePath: (path: string, type?: string) => revalidatePath(path, type),
}))

const { closeDb } = await import("@/db/client")
const { renameAccountAction } = await import("@/app/(app)/settings/actions")
const { signUpNewAccount } = await import("./helpers/auth.ts")
const { withTestPool } = await import("./helpers/database.ts")
const { isDatabaseConfigured } = await import("./helpers/environment.ts")

type Account = SignedUpUser

/** Matches `MAX_NAME_LENGTH` in the action. Duplicated so a silent widening fails here. */
const MAX_NAME_LENGTH = 120

/**
 * The two distinct rejections, so every case can assert **which** rule caught
 * it rather than only that something did. A name rejected for the right reason
 * and a name rejected for the wrong one are the same `ok: false`, and only the
 * first of those tells the customer what to change.
 */
const NEEDS_A_NAME = /needs a name/i
const TOO_LONG = new RegExp(`under ${MAX_NAME_LENGTH} characters`, "i")

function actAs(account: Account | null): void {
  requestHeaders.current =
    account === null ? new Headers() : new Headers({ cookie: account.cookie })
}

function formDataFor(fields: Record<string, string>): FormData {
  const formData = new FormData()

  for (const [key, value] of Object.entries(fields)) {
    formData.set(key, value)
  }

  return formData
}

/**
 * The stored name, read straight out of the table.
 *
 * Deliberately not `getAccountProfile` and emphatically not the action: a
 * read that shares a scoping bug with the write would agree with it, and the
 * pair would pass together.
 */
async function nameOf(accountId: string): Promise<string | null> {
  return withTestPool(async (pool) => {
    const { rows } = await pool.query<{ name: string }>(
      "SELECT name FROM accounts WHERE id = $1",
      [accountId]
    )

    return rows[0]?.name ?? null
  })
}

/** How many account rows carry this name, across the whole table. */
async function countNamed(name: string): Promise<number> {
  return withTestPool(async (pool) => {
    const { rows } = await pool.query<{ hits: string }>(
      "SELECT count(*)::text AS hits FROM accounts WHERE name = $1",
      [name]
    )

    return Number(rows[0]?.hits ?? 0)
  })
}

const describeDatabase = describe.skipIf(!isDatabaseConfigured())

afterAll(async () => {
  await closeDb()
})

describeDatabase("renameAccountAction is scoped by the session", () => {
  let first: Account
  let second: Account
  let secondNameBefore: string | null

  beforeAll(async () => {
    first = await signUpNewAccount()
    second = await signUpNewAccount()
  })

  beforeEach(async () => {
    revalidatePath.mockClear()
    secondNameBefore = await nameOf(second.accountId)

    expect(
      secondNameBefore,
      "the second account must exist for its row to prove anything"
    ).not.toBeNull()
  })

  /**
   * The test this file exists for.
   *
   * The submitted form names the second account in every field a hostile caller
   * might guess the action reads. The first account's name changing is the
   * positive control — without it the second account's name being untouched
   * would also be satisfied by a rename that silently did nothing at all.
   */
  it("ignores an account id in the form and renames only the session account", async () => {
    actAs(first)

    const name = `session scoped ${randomUUID()}`

    const result = await renameAccountAction(
      formDataFor({
        name,
        accountId: second.accountId,
        account_id: second.accountId,
        accountID: second.accountId,
        id: second.accountId,
        tenantId: second.accountId,
        tenant_id: second.accountId,
        organizationId: second.accountId,
        organization_id: second.accountId,
        workspaceId: second.accountId,
        userId: second.userId,
      })
    )

    expect(result).toStrictEqual({ ok: true })

    expect(
      await nameOf(first.accountId),
      "the signed-in account is the one that should have been renamed"
    ).toBe(name)

    expect(
      await nameOf(second.accountId),
      "a form field redirected the write at another tenant"
    ).toBe(secondNameBefore)

    // Catches the other shape of the same bug: a `where` clause dropped
    // entirely, which renames every account and would still leave the first
    // account looking correct.
    expect(
      await countNamed(name),
      "more than one account ended up with this name"
    ).toBe(1)
  })

  it("renames the other account when that account is the one signed in", async () => {
    actAs(second)

    const name = `second account ${randomUUID()}`
    const firstNameBefore = await nameOf(first.accountId)

    expect(await renameAccountAction(formDataFor({ name }))).toStrictEqual({
      ok: true,
    })

    expect(await nameOf(second.accountId)).toBe(name)
    expect(await nameOf(first.accountId)).toBe(firstNameBefore)
  })

  it("trims the stored name", async () => {
    actAs(first)

    const name = `trimmed ${randomUUID()}`

    expect(
      await renameAccountAction(formDataFor({ name: `  \t${name}\n  ` }))
    ).toStrictEqual({ ok: true })

    expect(await nameOf(first.accountId)).toBe(name)
  })

  it("accepts a name of exactly the maximum length", async () => {
    actAs(first)

    const name = "x".repeat(MAX_NAME_LENGTH)

    expect(await renameAccountAction(formDataFor({ name }))).toStrictEqual({
      ok: true,
    })

    expect(await nameOf(first.accountId)).toBe(name)
  })

  /**
   * The control the rejection list above needs.
   *
   * A rule that rejects names which render as nothing is one careless regex
   * away from rejecting anything unfamiliar — a non-Latin script, an emoji, a
   * name that merely *contains* a zero-width character. Each of these must
   * still save, so the rule cannot quietly become "reject anything unusual"
   * without this block going red.
   *
   * They must also save **verbatim**. The action's contract is reject-or-store,
   * never silently sanitize: a name handed back with its zero-widths stripped
   * would be a second, quieter bug wearing a passing test.
   */
  it.each([
    ["an embedded zero-width space", "Acme\u200BCorp"],
    ["an embedded word joiner", "Acme\u2060Corp"],
    ["one visible character among zero-widths", "\u200Bx\u2060"],
    ["a non-Latin script", "株式会社"],
    ["an emoji", "🎉"],
  ])("accepts a name with %s and stores it verbatim", async (_label, name) => {
    actAs(first)

    expect(await renameAccountAction(formDataFor({ name }))).toStrictEqual({
      ok: true,
    })

    expect(
      await nameOf(first.accountId),
      "accepted, but stored as something else — it sanitized silently"
    ).toBe(name)

    expect(revalidatePath).toHaveBeenCalledWith("/", "layout")
  })

  it("revalidates the whole layout, because the name is in every page shell", async () => {
    actAs(first)

    await renameAccountAction(formDataFor({ name: `shell ${randomUUID()}` }))

    expect(revalidatePath).toHaveBeenCalledWith("/", "layout")
  })

  /**
   * Rejections, each asserted as "the stored name did not move" **and** as the
   * rule that fired.
   *
   * The over-length cases are one character past the limit rather than wildly
   * over it, so the boundary is pinned from both sides — the accepted case
   * above is exactly `MAX_NAME_LENGTH`.
   *
   * The zero-width entries are the interesting half. `String.trim()` strips
   * U+00A0 but not U+200B, U+2060 or U+202E, so an emptiness check built on
   * `trim()` alone accepts a name that renders as a blank sidebar and a blank
   * breadcrumb on every page. Every one is written as an escape on purpose: a
   * literal would be invisible in this source, and an editor would "tidy" it
   * into an ordinary space without anyone noticing.
   */
  it.each([
    ["the empty string", "", NEEDS_A_NAME],
    ["a single space", " ", NEEDS_A_NAME],
    ["only whitespace", "   \t\n  ", NEEDS_A_NAME],
    ["a non-breaking space", "\u00A0", NEEDS_A_NAME],
    ["a zero-width space", "\u200B", NEEDS_A_NAME],
    ["a word joiner", "\u2060", NEEDS_A_NAME],
    ["a byte-order mark", "\uFEFF", NEEDS_A_NAME],
    ["a right-to-left override", "\u202E", NEEDS_A_NAME],
    ["a control character", "\u0001", NEEDS_A_NAME],
    [
      "zero-width characters mixed with ordinary spaces",
      " \u200B \u2060\uFEFF ",
      NEEDS_A_NAME,
    ],
    ["one character over the limit", "x".repeat(MAX_NAME_LENGTH + 1), TOO_LONG],
    [
      "whitespace padding a name that is still over the limit",
      `  ${"x".repeat(MAX_NAME_LENGTH + 1)}  `,
      TOO_LONG,
    ],
    // Both rules match this one. The emptiness check runs first and the message
    // says so, because telling someone their invisible name is too long is
    // useless advice.
    [
      "an over-length run of zero-width characters",
      "\u200B".repeat(MAX_NAME_LENGTH + 1),
      NEEDS_A_NAME,
    ],
  ])(
    "rejects %s without writing",
    async (_label, submitted, expectedMessage) => {
      actAs(first)

      const before = await nameOf(first.accountId)
      const result = await renameAccountAction(formDataFor({ name: submitted }))

      expect(result.ok).toBe(false)
      expect(
        result,
        "rejected, but by the wrong rule — the message would misdirect the user"
      ).toHaveProperty("message", expect.stringMatching(expectedMessage))

      expect(
        await nameOf(first.accountId),
        "a rejected rename wrote anyway"
      ).toBe(before)

      expect(
        revalidatePath,
        "a rejected rename revalidated, which says it thought it had written"
      ).not.toHaveBeenCalled()
    }
  )

  it("rejects a form with no name field at all", async () => {
    actAs(first)

    const before = await nameOf(first.accountId)

    expect((await renameAccountAction(new FormData())).ok).toBe(false)
    expect(await nameOf(first.accountId)).toBe(before)
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  /**
   * `FormData.get` returns a `File` for a file part, not a string. The action
   * has to treat that as absent rather than stringify it into `[object File]`.
   */
  it("rejects a name submitted as a file part", async () => {
    actAs(first)

    const before = await nameOf(first.accountId)
    const formData = new FormData()
    formData.set("name", new File(["Attacker Co"], "name.txt"))

    expect((await renameAccountAction(formData)).ok).toBe(false)
    expect(await nameOf(first.accountId)).toBe(before)
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  /**
   * With no session there is no account to scope to, so the action must fail
   * closed. A form field naming a real account is present precisely so that a
   * version that fell back to `formData` would rename it and fail here.
   */
  it("refuses to write at all without a session", async () => {
    actAs(null)

    const firstNameBefore = await nameOf(first.accountId)
    const name = `unauthenticated ${randomUUID()}`

    await expect(
      renameAccountAction(
        formDataFor({ name, accountId: first.accountId, id: first.accountId })
      )
    ).rejects.toThrow(/not authenticated/i)

    expect(await nameOf(first.accountId)).toBe(firstNameBefore)
    expect(await nameOf(second.accountId)).toBe(secondNameBefore)
    expect(await countNamed(name)).toBe(0)
  })

  /**
   * A forged cookie is rejected the same way an absent one is. Without this,
   * "fails closed" would only be proven for the case where the caller supplies
   * nothing, which is not the case an attacker is in.
   */
  it("refuses to write for a forged session token", async () => {
    requestHeaders.current = new Headers({
      cookie: "better-auth.session_token=not-a-real-token",
    })

    const firstNameBefore = await nameOf(first.accountId)

    await expect(
      renameAccountAction(
        formDataFor({
          name: `forged ${randomUUID()}`,
          accountId: first.accountId,
        })
      )
    ).rejects.toThrow(/not authenticated/i)

    expect(await nameOf(first.accountId)).toBe(firstNameBefore)
    expect(await nameOf(second.accountId)).toBe(secondNameBefore)
  })
})
