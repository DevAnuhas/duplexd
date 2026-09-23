import { randomUUID } from "node:crypto"

import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import type { SignedUpUser } from "./helpers/auth.ts"

/**
 * The home dashboard's call tiles count Integration calls only.
 *
 * `getShellContext` feeds the "Calls" and "Incomplete calls" tiles and the
 * sidebar badge. A Practice test is a Sandbox call against sample data; if it
 * raised those numbers, a sample outcome would be reported as a real
 * integration outcome, and the tile would disagree with the Integration-only
 * recent list it sits beside (`listCallsForAccount`).
 *
 * The seed is chosen so each rule is visible on its own:
 *
 * - one incomplete Sandbox call and one ended Sandbox call — both must be
 *   invisible, the first to `incompleteCalls`, the second to `calls`;
 * - one incomplete Integration call and one ended Integration call — both must
 *   count. These are the accept controls: a filter that excluded every row
 *   would pass the Sandbox half and fail here;
 * - one Integration row inserted **without** `source`, relying on the column
 *   default, because every call written before the column existed looks like
 *   that;
 * - a second account with an incomplete Integration call, so the new source
 *   predicate cannot have displaced the account predicate.
 *
 * Rows are inserted directly rather than driven through the Sandbox lifecycle.
 * The subject is the count, not how a call reaches `incomplete`, and the
 * lifecycle has its own tests.
 */

const { closeDb, getDb } = await import("@/db/client")
const { calls } = await import("@/db/schema")
const { getShellContext } = await import("@/data/accounts")
const { listCallsForAccount } = await import("@/data/calls")
const { signUpNewAccount } = await import("./helpers/auth.ts")
const { isDatabaseConfigured } = await import("./helpers/environment.ts")

const describeDatabase = describe.skipIf(!isDatabaseConfigured())

type Seed = {
  accountId: string
  state: "incomplete" | "ended"
  /** `undefined` leaves the column to its default, like a pre-Sandbox row. */
  source?: "integration" | "sandbox"
}

async function seedCall(seed: Seed): Promise<string> {
  const id = `call-${randomUUID()}`
  const sandbox = seed.source === "sandbox"

  await getDb()
    .insert(calls)
    .values({
      id,
      accountId: seed.accountId,
      assistantSnapshot: {},
      ...(seed.source === undefined ? {} : { source: seed.source }),
      testMode: sandbox ? "practice" : null,
      configSource: sandbox ? "saved" : null,
      agentTokenHash: randomUUID().replaceAll("-", "").padEnd(64, "0"),
      state: seed.state,
      endedReason: seed.state === "ended" ? "client_disconnected" : null,
      durationSecs: 4.5,
    })

  return id
}

async function countsFor(account: SignedUpUser) {
  const shell = await getShellContext(account.accountId, account.userId)

  if (shell === null) {
    throw new Error("Shell context missing for a freshly signed-up account.")
  }

  return shell.counts
}

describeDatabase("getShellContext call counts", () => {
  let tenant: SignedUpUser
  let neighbour: SignedUpUser
  const integrationIds: string[] = []

  beforeAll(async () => {
    tenant = await signUpNewAccount()
    neighbour = await signUpNewAccount()

    await seedCall({
      accountId: tenant.accountId,
      source: "sandbox",
      state: "incomplete",
    })
    await seedCall({
      accountId: tenant.accountId,
      source: "sandbox",
      state: "ended",
    })

    integrationIds.push(
      await seedCall({
        accountId: tenant.accountId,
        source: "integration",
        state: "incomplete",
      }),
      await seedCall({
        accountId: tenant.accountId,
        source: "integration",
        state: "ended",
      }),
      await seedCall({ accountId: tenant.accountId, state: "ended" })
    )

    await seedCall({
      accountId: neighbour.accountId,
      source: "integration",
      state: "incomplete",
    })
  })

  afterAll(async () => {
    await closeDb()
  })

  it("seeds exactly what the assertions assume", async () => {
    // Guards the fixture itself: if the column default ever changed, the
    // sourceless row would silently become a Sandbox row and the counts below
    // would be asserting against a different seed than the one described.
    const mine = await getDb()
      .select({ source: calls.source, state: calls.state })
      .from(calls)
      .where(eq(calls.accountId, tenant.accountId))

    expect(mine.map((row) => `${row.source}:${row.state}`).sort()).toEqual([
      "integration:ended",
      "integration:ended",
      "integration:incomplete",
      "sandbox:ended",
      "sandbox:incomplete",
    ])
  })

  it("counts Integration calls only, including rows written before source existed", async () => {
    const counts = await countsFor(tenant)

    // All-sources would be 5 and 2. Anything other than 3 and 1 means a
    // Sandbox row leaked in or an Integration row fell out.
    expect(counts.calls).toBe(3)
    expect(counts.incompleteCalls).toBe(1)
  })

  it("agrees with the Integration-only recent calls list beside it", async () => {
    const counts = await countsFor(tenant)
    const listed = await listCallsForAccount(tenant.accountId, { limit: 100 })

    if (listed.kind !== "ok") throw new Error("Unexpected invalid cursor.")

    expect(listed.calls.map((call) => call.id).sort()).toEqual(
      [...integrationIds].sort()
    )
    expect(counts.calls).toBe(listed.calls.length)
    expect(counts.incompleteCalls).toBe(
      listed.calls.filter((call) => call.state === "incomplete").length
    )
  })

  it("still scopes every call count by account", async () => {
    expect(await countsFor(neighbour)).toMatchObject({
      calls: 1,
      incompleteCalls: 1,
    })
  })
})
