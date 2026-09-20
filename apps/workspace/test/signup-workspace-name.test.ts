import { randomUUID } from "node:crypto"

import { afterAll, describe, expect, it } from "vitest"

import { closeDb } from "@/db/client"
import { getAuth } from "@/lib/auth"
import { WORKSPACE_NAME_MAX_LENGTH } from "@/lib/auth-schemas"

import { withTestPool } from "./helpers/database.ts"
import { isDatabaseConfigured } from "./helpers/environment.ts"

/**
 * The workspace name's trip from the signup body to `accounts.name`.
 *
 * This is the one piece of the signup path that is not obvious from reading
 * either end. `workspaceName` is **not** a column on `users`: it rides the
 * request body, survives Better Auth's validation, and is read off the endpoint
 * context inside `databaseHooks.user.create.before`. Two library details have
 * to hold for that to work, and both were verified by reading
 * `node_modules/better-auth@1.7.5` rather than assumed:
 *
 *  - `dist/api/routes/sign-up.mjs` ends its body schema with
 *    `}).and(z.record(z.string(), z.any()))` — an intersection with a
 *    catch-all, so unknown keys survive validation instead of being stripped;
 *  - `dist/db/with-hooks.mjs` invokes the hook as `toRun(actualData, context)`,
 *    so the endpoint context — and with it `context.body` — reaches the hook.
 *
 * If either changes in a future Better Auth, the workspace name silently
 * becomes the email and nobody finds out from a type error. That is what this
 * file exists to catch, which is why every assertion reads `accounts` back
 * with a raw `SELECT` rather than through `getAccountProfile` — a read sharing
 * a bug with the write would agree with it and the pair would pass together.
 *
 * Nothing is mocked. Real Better Auth handler, real signup, real database.
 */

/** Where the handler thinks it lives. Better Auth parses the path from this. */
const ORIGIN = "http://localhost:3000"

/** Distinctive and unique per run, so rows from an earlier run cannot match. */
function uniqueEmail(): string {
  return `workspace-${randomUUID()}@example.invalid`
}

const PASSWORD = `signup-password-${randomUUID()}`

/** Posts a signup body verbatim, so a case can omit a field entirely. */
async function signUp(body: Record<string, unknown>): Promise<Response> {
  return getAuth().handler(
    new Request(`${ORIGIN}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  )
}

type StoredNames = {
  accountId: string
  accountName: string
  personName: string | null
}

/** The account and user rows for an address, straight out of the tables. */
async function storedNamesFor(email: string): Promise<StoredNames | null> {
  return withTestPool(async (pool) => {
    const { rows } = await pool.query<{
      account_id: string
      account_name: string
      person_name: string | null
    }>(
      `SELECT a.id AS account_id, a.name AS account_name, u.name AS person_name
         FROM users u
         JOIN accounts a ON a.id = u.account_id
        WHERE u.email = $1`,
      [email]
    )

    const row = rows[0]

    return row === undefined
      ? null
      : {
          accountId: row.account_id,
          accountName: row.account_name,
          personName: row.person_name,
        }
  })
}

/**
 * Signs up and returns what landed in the database.
 *
 * Signup failures throw with the response body rather than returning a null
 * that a later assertion would report as "the name was wrong".
 */
async function signUpAndRead(
  body: Record<string, unknown>
): Promise<StoredNames> {
  const response = await signUp(body)

  if (!response.ok) {
    throw new Error(
      `Signup failed with ${response.status}: ${await response.text()}`
    )
  }

  const stored = await storedNamesFor(body.email as string)

  if (stored === null) {
    throw new Error("Signup reported success but wrote no user row.")
  }

  return stored
}

/** How many users sit on an account. The signup hook must never add a second. */
async function usersOnAccount(accountId: string): Promise<number> {
  return withTestPool(async (pool) => {
    const { rows } = await pool.query<{ members: string }>(
      "SELECT count(*)::text AS members FROM users WHERE account_id = $1",
      [accountId]
    )

    return Number(rows[0]?.members ?? 0)
  })
}

const describeDatabase = describe.skipIf(!isDatabaseConfigured())

afterAll(async () => {
  await closeDb()
})

describeDatabase("the workspace name given at signup", () => {
  /**
   * The test the file exists for.
   *
   * The assertion that the account is **not** named after the email is the
   * load-bearing half. Without it, a hook that ignored the context entirely
   * would still satisfy "an account exists with a name", and the fallback
   * below would make that look deliberate.
   */
  it("names the account, and the person separately", async () => {
    const email = uniqueEmail()
    const stored = await signUpAndRead({
      email,
      password: PASSWORD,
      name: "Alex Doe",
      workspaceName: "Acme Logistics",
    })

    expect(
      stored.accountName,
      "the workspace name did not reach accounts.name"
    ).toBe("Acme Logistics")

    expect(
      stored.accountName,
      "the account fell back to the email, so the context never arrived"
    ).not.toBe(email)

    expect(stored.personName, "the person name did not reach users.name").toBe(
      "Alex Doe"
    )
  })

  it("gives two signups their own separate workspaces", async () => {
    const first = await signUpAndRead({
      email: uniqueEmail(),
      password: PASSWORD,
      name: "Alex Doe",
      workspaceName: "First Workspace",
    })
    const second = await signUpAndRead({
      email: uniqueEmail(),
      password: PASSWORD,
      name: "Sam Roe",
      workspaceName: "Second Workspace",
    })

    expect(first.accountName).toBe("First Workspace")
    expect(second.accountName).toBe("Second Workspace")
    expect(first.accountId).not.toBe(second.accountId)
  })

  it("trims the workspace name before storing it", async () => {
    const stored = await signUpAndRead({
      email: uniqueEmail(),
      password: PASSWORD,
      name: "Alex Doe",
      workspaceName: "  \tAcme Logistics\n  ",
    })

    expect(stored.accountName, "the padding survived into accounts.name").toBe(
      "Acme Logistics"
    )
  })

  /**
   * The fallback, which is deliberate and load-bearing.
   *
   * An older client or a direct API call that sends no workspace name must
   * still produce a usable account — `users.account_id` is NOT NULL, so the
   * alternative to a fallback is a signup that fails outright. An account named
   * after its owner's address is recoverable; the rename form on Settings
   * exists for exactly that.
   */
  it.each([
    ["the field is absent entirely", undefined],
    ["it is the empty string", ""],
    ["it is only whitespace", "   "],
    ["it is a tab and a newline", "\t\n"],
    // A non-string cannot come from the form, but it can come from a direct
    // API call, and the hook's `typeof` guard is what keeps `[object Object]`
    // out of the sidebar.
    ["it is a number", 42],
    ["it is null", null],
    ["it is an object", { name: "Acme" }],
  ])("falls back to the email when %s", async (_label, workspaceName) => {
    const email = uniqueEmail()
    const body: Record<string, unknown> = {
      email,
      password: PASSWORD,
      name: "Alex Doe",
    }

    if (workspaceName !== undefined) {
      body.workspaceName = workspaceName
    }

    const stored = await signUpAndRead(body)

    expect(
      stored.accountName,
      "the account was not named after the email, so the fallback did not run"
    ).toBe(email)

    expect(stored.accountId, "the fallback produced no account at all").toMatch(
      /\S/
    )

    // The person's name is unaffected by the workspace name's absence.
    expect(stored.personName).toBe("Alex Doe")
  })

  /**
   * The cap is enforced where the value is **written**, not only where it is
   * typed.
   *
   * This test was originally the opposite: it pinned that a direct API call
   * could set a name of any length, because the 120 bound lived in
   * `signUpSchema` and the rename action but not in the hook. It failed the
   * moment that was closed, which is what it was written to do — the comment
   * said to invert it rather than treat the failure as a regression.
   *
   * Signup **truncates** where the rename action rejects, and the asymmetry is
   * deliberate: an authenticated edit should be told it did nothing, while a
   * signup has a sensible answer available and no good moment to argue.
   */
  it("bounds an over-long workspace name at the cap", async () => {
    const stored = await signUpAndRead({
      email: uniqueEmail(),
      password: PASSWORD,
      name: "Alex Doe",
      workspaceName: "x".repeat(500),
    })

    expect(stored.accountName).toBe("x".repeat(WORKSPACE_NAME_MAX_LENGTH))
  })

  it("leaves a name at exactly the cap untouched", async () => {
    const atCap = "y".repeat(WORKSPACE_NAME_MAX_LENGTH)
    const stored = await signUpAndRead({
      email: uniqueEmail(),
      password: PASSWORD,
      name: "Alex Doe",
      workspaceName: atCap,
    })

    expect(stored.accountName).toBe(atCap)
  })

  /**
   * A name made only of invisible characters falls back like an empty one.
   *
   * `trim()` does not strip U+200B, so without a dedicated guard this would
   * name the workspace something that renders as a blank sidebar on every
   * page — the same defect that was closed for the rename action, reaching the
   * column by its other writer.
   */
  it.each([
    ["a zero-width space", "\u200B"],
    ["a word joiner", "\u2060"],
    ["zero-widths around ordinary spaces", " \u200B \u2060 "],
  ])(
    "falls back to the email when the name is only %s",
    async (_label, invisible) => {
      const email = uniqueEmail()
      const stored = await signUpAndRead({
        email,
        password: PASSWORD,
        name: "Alex Doe",
        workspaceName: invisible,
      })

      expect(
        stored.accountName,
        "an invisible workspace name was stored, so the sidebar renders blank"
      ).toBe(email)
    }
  )

  /**
   * The person's name gets the same treatment, for the same reason.
   *
   * `users.name` arrives on Better Auth's own body, so before it was
   * normalized in the hook the form schema was the only thing bounding it —
   * the client-side-only shape the workspace name had. It is what the user
   * menu shows instead of the address, so an invisible name renders that menu
   * blank.
   */
  it("stores a real person name verbatim", async () => {
    const stored = await signUpAndRead({
      email: uniqueEmail(),
      password: PASSWORD,
      name: "Alex Doe",
      workspaceName: "Acme Logistics",
    })

    expect(stored.personName).toBe("Alex Doe")
  })

  it.each([
    ["a zero-width space", "\u200B"],
    ["a word joiner", "\u2060"],
    ["only whitespace", "   "],
    ["zero-widths among spaces", " \u200B \u2060 "],
  ])(
    "falls back to the email when the person name is %s",
    async (_label, invisible) => {
      const email = uniqueEmail()
      const stored = await signUpAndRead({
        email,
        password: PASSWORD,
        name: invisible,
        workspaceName: "Acme Logistics",
      })

      expect(
        stored.personName,
        "an invisible person name was stored, so the user menu renders blank"
      ).toBe(email)

      // The workspace name is unaffected — the two fall back independently.
      expect(stored.accountName).toBe("Acme Logistics")
    }
  )

  it("bounds an over-long person name at the cap", async () => {
    const stored = await signUpAndRead({
      email: uniqueEmail(),
      password: PASSWORD,
      name: "z".repeat(500),
      workspaceName: "Acme Logistics",
    })

    expect(stored.personName).toBe("z".repeat(WORKSPACE_NAME_MAX_LENGTH))
  })

  /**
   * **The signup body cannot choose its own account** — and it is stopped
   * twice, which is worth knowing precisely because the code comment says
   * otherwise.
   *
   * The same catch-all that carries `workspaceName` carries anything, so a
   * caller can put `accountId` in the signup body. The hook's defence is that
   * it spreads its own `accountId` **after** `...user`, and its comment says
   * that ordering is the only thing protecting the tenant boundary.
   *
   * Measured, it is not: Better Auth refuses the field outright with
   * `400 FIELD_NOT_ALLOWED` before the hook ever runs, because `accountId` is
   * a known column on the user model that is not marked as caller-settable.
   * The spread ordering is a backstop behind that, not the front line.
   *
   * Both halves are pinned below, because either could change independently —
   * a Better Auth upgrade could relax the field guard, and a refactor could
   * reorder the spread. The first test is the one that would notice a library
   * change; the second is the one that notices a near-miss spelling slipping
   * past both.
   */
  it("refuses a signup that names an accountId, and writes nothing", async () => {
    const existingEmail = uniqueEmail()
    const existing = await signUpAndRead({
      email: existingEmail,
      password: PASSWORD,
      name: "Alex Doe",
      workspaceName: "Existing Workspace",
    })

    const joinerEmail = uniqueEmail()
    const response = await signUp({
      email: joinerEmail,
      password: PASSWORD,
      name: "Sam Roe",
      workspaceName: "Joiner Workspace",
      accountId: existing.accountId,
    })

    expect(
      response.status,
      "the signup body was allowed to name an account"
    ).toBe(400)

    // Asserted as post-state, not just as a status code: a refusal that
    // wrote a row anyway satisfies the first and fails this.
    expect(await storedNamesFor(joinerEmail)).toBeNull()

    expect(
      await usersOnAccount(existing.accountId),
      "a second user landed on an existing account"
    ).toBe(1)
  })

  /**
   * The near misses. None of these is a column the hook reads, so each must be
   * inert — accepted, ignored, and given its own account like any signup.
   *
   * The positive control is inside each case: the signup has to *succeed* and
   * get its own workspace. Without that, a signup that failed for an unrelated
   * reason would satisfy "did not join the other tenant" and prove nothing.
   */
  it.each(["account_id", "accountID", "id", "emailVerified"])(
    "ignores a %s supplied in the signup body",
    async (field) => {
      const existingEmail = uniqueEmail()
      const existing = await signUpAndRead({
        email: existingEmail,
        password: PASSWORD,
        name: "Alex Doe",
        workspaceName: "Existing Workspace",
      })

      const joiner = await signUpAndRead({
        email: uniqueEmail(),
        password: PASSWORD,
        name: "Sam Roe",
        workspaceName: "Joiner Workspace",
        [field]: existing.accountId,
      })

      expect(
        joiner.accountId,
        `${field} chose the account, so a stranger joined a tenant`
      ).not.toBe(existing.accountId)

      expect(joiner.accountName).toBe("Joiner Workspace")
      expect(await usersOnAccount(existing.accountId)).toBe(1)
      expect(await usersOnAccount(joiner.accountId)).toBe(1)

      expect(
        (await storedNamesFor(existingEmail))?.accountName,
        "the existing tenant's workspace was renamed by someone else's signup"
      ).toBe("Existing Workspace")
    }
  )
})
