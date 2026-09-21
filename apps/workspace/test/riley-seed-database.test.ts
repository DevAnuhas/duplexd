import { randomUUID } from "node:crypto"

import { and, eq, sql } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { getDb, closeDb } from "@/db/client"
import { assistants, users } from "@/db/schema"

import { rileyDemo, rileyDemoId } from "../scripts/riley-demo.ts"
import { seedRiley } from "../scripts/seed-riley.ts"
import { signUpNewAccount, type SignedUpUser } from "./helpers/auth.ts"
import { isDatabaseConfigured } from "./helpers/environment.ts"

/**
 * The Riley demo seed against a real database.
 *
 * `test/riley-seed.test.ts` covers the argument parsing and the preview. This
 * file covers the insert, and it is written around the three ways a seed script
 * damages a workspace rather than around its happy path:
 *
 *  1. **A rerun overwrites the customer's work.** The seed is insert-only, so a
 *     renamed, edited or archived demo has to survive a second run untouched.
 *     Asserting "the second run said already_exists" does not prove that — an
 *     upsert that reported the same string would pass it — so every assertion
 *     below is against the **row**, read back after the rerun.
 *  2. **It writes into the wrong account.** The identifier is derived from the
 *     account, so two accounts seeded on one database must not meet, and a
 *     planted collision must refuse rather than adopt the other account's row.
 *  3. **It writes something on a path that was supposed to refuse.** A missing
 *     owner is asserted as post-state — no new rows anywhere — not as a thrown
 *     error, because an insert that threw after committing satisfies the error
 *     assertion and still leaves the damage.
 *
 * Every isolation assertion is paired with a positive control. Without one, a
 * seed that had stopped inserting entirely would satisfy most of this file.
 */

const describeDatabase = describe.skipIf(!isDatabaseConfigured())

afterAll(async () => {
  await closeDb()
})

/** The demo row for an account, or `null`. */
async function demoRowFor(accountId: string) {
  const rows = await getDb()
    .select()
    .from(assistants)
    .where(eq(assistants.id, rileyDemoId(accountId)))
    .limit(1)

  return rows[0] ?? null
}

/** How many assistants an account owns. */
async function assistantCountFor(accountId: string): Promise<number> {
  const rows = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(assistants)
    .where(eq(assistants.accountId, accountId))

  return rows[0]?.count ?? 0
}

/** How many assistants exist at all, for the "nothing was written" assertions. */
async function assistantCount(): Promise<number> {
  const rows = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(assistants)

  return rows[0]?.count ?? 0
}

describeDatabase("seeding a workspace that has an owner", () => {
  let owner: SignedUpUser

  beforeAll(async () => {
    owner = await signUpNewAccount()
  })

  it("creates the demo in that owner's account", async () => {
    const result = await seedRiley(owner.email)

    expect(result).toStrictEqual({
      status: "created",
      assistantId: rileyDemoId(owner.accountId),
      accountId: owner.accountId,
      editorPath: `/assistants/${rileyDemoId(owner.accountId)}`,
    })

    const row = await demoRowFor(owner.accountId)

    expect(row?.accountId).toBe(owner.accountId)
    expect(row?.name).toBe(rileyDemo().name)
    expect(row?.instructions).toBe(rileyDemo().instructions)
    expect(row?.tools).toStrictEqual(rileyDemo().tools)
    expect(row?.archivedAt).toBeNull()
  })

  /**
   * The row is written disconnected. A seeded demo that arrived with a webhook
   * or a stored secret would be a live integration nobody asked for.
   */
  it("writes a disconnected row: no webhook, no secret", async () => {
    const row = await demoRowFor(owner.accountId)

    expect(row?.serverUrl).toBeNull()
    expect(row?.serverSecrets).toStrictEqual([])
  })

  it("reports already_exists on a rerun, and inserts nothing new", async () => {
    const before = await assistantCountFor(owner.accountId)
    const result = await seedRiley(owner.email)

    expect(result.status).toBe("already_exists")
    expect(result.assistantId).toBe(rileyDemoId(owner.accountId))
    expect(await assistantCountFor(owner.accountId)).toBe(before)
  })

  /**
   * The owner is matched case-insensitively and after trimming, because the
   * email is typed into a shell by hand. A seed that missed the user here would
   * report "no such user" to someone looking at their own account.
   */
  it.each([
    ["uppercased", (email: string) => email.toUpperCase()],
    ["padded with whitespace", (email: string) => `  ${email}  `],
  ])("finds the same owner from a %s email", async (_label, transform) => {
    const result = await seedRiley(transform(owner.email))

    expect(result.accountId).toBe(owner.accountId)
    expect(result.status).toBe("already_exists")
  })
})

describeDatabase("a demo the customer has since edited", () => {
  let owner: SignedUpUser
  let untouched: SignedUpUser
  const editedName = `renamed by the customer ${randomUUID()}`

  beforeAll(async () => {
    owner = await signUpNewAccount()
    untouched = await signUpNewAccount()

    await seedRiley(owner.email)
    await getDb()
      .update(assistants)
      .set({
        name: editedName,
        instructions: "The customer rewrote this.",
        tools: [],
        serverUrl: "https://customer.example.invalid/hook",
      })
      .where(eq(assistants.id, rileyDemoId(owner.accountId)))
  })

  it("keeps every edit across a rerun, and still points at the editor", async () => {
    const result = await seedRiley(owner.email)

    expect(result.status).toBe("already_exists")
    expect(result.editorPath).toBe(
      `/assistants/${rileyDemoId(owner.accountId)}`
    )

    const row = await demoRowFor(owner.accountId)

    expect(row?.name).toBe(editedName)
    expect(row?.instructions).toBe("The customer rewrote this.")
    expect(row?.tools).toStrictEqual([])
    expect(row?.serverUrl).toBe("https://customer.example.invalid/hook")
    expect(row?.archivedAt).toBeNull()
  })

  /**
   * The control. Everything above would also pass if the seed had stopped
   * inserting — "your edits survived" is indistinguishable from "nothing
   * happens any more" without a case that still expects a row to appear.
   */
  it("still inserts for an account that has no demo yet (control)", async () => {
    expect((await seedRiley(untouched.email)).status).toBe("created")
    expect(await demoRowFor(untouched.accountId)).not.toBeNull()
  })
})

/**
 * Archived is reported as its own status, separately from "already exists".
 *
 * The two are the same row to the database and different situations to the
 * person running the seed: an archived demo is one the customer deliberately
 * put away, so the script must neither revive it nor hand back an editor link
 * that opens something the workspace no longer lists. `editorPath` is `null`
 * for exactly that reason, and the row is left exactly as it was found.
 */
describeDatabase("a demo the customer has archived", () => {
  let owner: SignedUpUser
  const archivedAt = new Date("2026-01-02T03:04:05.000Z")
  const archivedName = `archived by the customer ${randomUUID()}`

  beforeAll(async () => {
    owner = await signUpNewAccount()

    await seedRiley(owner.email)
    await getDb()
      .update(assistants)
      .set({ name: archivedName, archivedAt })
      .where(eq(assistants.id, rileyDemoId(owner.accountId)))
  })

  it("says so, withholds the editor link, and revives nothing", async () => {
    const result = await seedRiley(owner.email)

    expect(result.status).toBe("already_exists_archived")
    expect(result.editorPath).toBeNull()
    expect(result.assistantId).toBe(rileyDemoId(owner.accountId))

    const row = await demoRowFor(owner.accountId)

    expect(row?.archivedAt?.toISOString()).toBe(archivedAt.toISOString())
    expect(row?.name).toBe(archivedName)
    expect(await assistantCountFor(owner.accountId)).toBe(1)
  })
})

describeDatabase("two accounts on one database", () => {
  let owner: SignedUpUser
  let neighbour: SignedUpUser

  beforeAll(async () => {
    owner = await signUpNewAccount()
    neighbour = await signUpNewAccount()
  })

  it("gives each account its own row, and leaves the other alone", async () => {
    await seedRiley(owner.email)

    const neighbourBefore = await assistantCountFor(neighbour.accountId)

    expect(neighbourBefore).toBe(0)

    await seedRiley(neighbour.email)

    expect(rileyDemoId(owner.accountId)).not.toBe(
      rileyDemoId(neighbour.accountId)
    )
    expect(await assistantCountFor(owner.accountId)).toBe(1)
    expect(await assistantCountFor(neighbour.accountId)).toBe(1)

    const row = await demoRowFor(neighbour.accountId)

    expect(row?.accountId).toBe(neighbour.accountId)
  })
})

describeDatabase("an identifier already owned by another account", () => {
  let owner: SignedUpUser
  let victim: SignedUpUser

  beforeAll(async () => {
    owner = await signUpNewAccount()
    victim = await signUpNewAccount()

    // The victim's own identifier, planted under the owner's account. This is
    // the collision the seed has to refuse: the row exists, the insert is a
    // no-op, and adopting it would hand one account another's assistant.
    await getDb()
      .insert(assistants)
      .values({
        id: rileyDemoId(victim.accountId),
        accountId: owner.accountId,
        name: `planted ${randomUUID()}`,
        serverSecrets: [],
        tools: [],
      })
  })

  it("refuses, and writes nothing into the account that asked", async () => {
    await expect(seedRiley(victim.email)).rejects.toThrow(
      /already owned by another account/
    )

    expect(await assistantCountFor(victim.accountId)).toBe(0)
  })

  it("leaves the planted row with its original owner", async () => {
    const rows = await getDb()
      .select({ accountId: assistants.accountId })
      .from(assistants)
      .where(eq(assistants.id, rileyDemoId(victim.accountId)))

    expect(rows[0]?.accountId).toBe(owner.accountId)
  })
})

describeDatabase("an owner email that matches no user", () => {
  it("refuses, and writes no assistant anywhere", async () => {
    const before = await assistantCount()

    await expect(
      seedRiley(`nobody-${randomUUID()}@example.invalid`)
    ).rejects.toThrow(/No workspace user matches --owner-email/)

    expect(await assistantCount()).toBe(before)
  })

  /**
   * An empty email is the shape a shell hands over when a variable is unset —
   * `--owner-email "$EMAIL"` with nothing in it. It must not match a user, and
   * `parseSeedArgs` rejects it before this point; this asserts the data layer
   * refuses it too rather than relying on the parser alone.
   */
  it("refuses an empty owner email", async () => {
    const before = await assistantCount()

    await expect(seedRiley("")).rejects.toThrow(
      /No workspace user matches --owner-email/
    )

    expect(await assistantCount()).toBe(before)
  })
})

/**
 * Two users whose emails differ only in case.
 *
 * The lookup folds case, so this is the one input where "the owner" is a
 * genuine question rather than a lookup — and the two accounts are different
 * accounts. Picking either one is a cross-account write decided by row order,
 * so the seed has to refuse and say which problem it hit: this message and the
 * no-such-user one send the operator to different places, and a single "could
 * not find exactly one user" for both would have sent them to the wrong one.
 *
 * The collision is constructed by rewriting the second user's email, because
 * signup normalizes what it stores — the row shape is reachable by other
 * routes (an import, a manual fix, a case-folding change), and the seed's
 * behaviour against it is the point.
 */
describeDatabase("two users whose emails differ only in case", () => {
  let first: SignedUpUser
  let second: SignedUpUser
  let sharedEmail = ""

  beforeAll(async () => {
    first = await signUpNewAccount()
    second = await signUpNewAccount()
    sharedEmail = first.email

    await getDb()
      .update(users)
      .set({ email: sharedEmail.toUpperCase() })
      .where(eq(users.id, second.userId))
  })

  it("refuses rather than picking one, and writes into neither account", async () => {
    const before = await assistantCount()

    await expect(seedRiley(sharedEmail)).rejects.toThrow(
      /Multiple workspace users match this email ignoring case/
    )

    expect(await assistantCountFor(first.accountId)).toBe(0)
    expect(await assistantCountFor(second.accountId)).toBe(0)
    expect(await assistantCount()).toBe(before)
  })

  /**
   * The control, and the reason the message matters: once the ambiguity is
   * resolved the same command succeeds, and it succeeds for the account the
   * operator meant.
   */
  it("seeds normally once the ambiguity is resolved (control)", async () => {
    await getDb()
      .update(users)
      .set({ email: `resolved-${randomUUID()}@example.invalid` })
      .where(eq(users.id, second.userId))

    const result = await seedRiley(sharedEmail)

    expect(result.status).toBe("created")
    expect(result.accountId).toBe(first.accountId)
    expect(await assistantCountFor(second.accountId)).toBe(0)
  })
})

describeDatabase("a user whose account has other assistants", () => {
  let owner: SignedUpUser

  beforeAll(async () => {
    owner = await signUpNewAccount()

    await getDb()
      .insert(assistants)
      .values({
        id: `unrelated-${randomUUID()}`,
        accountId: owner.accountId,
        name: `unrelated ${randomUUID()}`,
        serverSecrets: [],
        tools: [],
      })
  })

  it("adds the demo without disturbing them", async () => {
    const result = await seedRiley(owner.email)

    expect(result.status).toBe("created")
    expect(await assistantCountFor(owner.accountId)).toBe(2)

    const others = await getDb()
      .select({ id: assistants.id })
      .from(assistants)
      .where(
        and(
          eq(assistants.accountId, owner.accountId),
          sql`${assistants.id} <> ${rileyDemoId(owner.accountId)}`
        )
      )

    expect(others).toHaveLength(1)
  })
})
