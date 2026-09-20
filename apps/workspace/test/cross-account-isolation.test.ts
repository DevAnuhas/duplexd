import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { closeDb } from "@/db/client"
import {
  createAssistant,
  getAssistantForAccount,
  listAssistantsForAccount,
} from "@/data/assistants"

import { signUpNewAccount, type SignedUpUser } from "./helpers/auth.ts"
import { isDatabaseConfigured } from "./helpers/environment.ts"

/**
 * Cross-account isolation, against production code.
 *
 * What this file deliberately does **not** do: assert that a `where` clause
 * exists. The clause is always present in the query somebody remembered — the
 * failure is the query somebody forgot, and a test that reads the source cannot
 * see the difference. So every assertion here is a real read, issued as a real
 * second account, against the real data-access functions P03 will extend.
 *
 * Both accounts come from the real Better Auth signup handler rather than an
 * `INSERT`, so the account rows are the ones signup actually produces.
 *
 * The positive controls are load-bearing. If `createAssistant` quietly wrote
 * nothing, every cross-account read would return nothing and this file would
 * pass while proving absolutely nothing. Each isolation assertion is therefore
 * paired with the owner successfully reading the same row.
 */

const describeDatabase = describe.skipIf(!isDatabaseConfigured())

describeDatabase(
  "a second account cannot read the first account’s rows",
  () => {
    let first: SignedUpUser
    let second: SignedUpUser
    let firstAssistantIds: string[] = []
    let secondAssistantId = ""

    beforeAll(async () => {
      first = await signUpNewAccount()
      second = await signUpNewAccount()

      const created = await Promise.all([
        createAssistant(first.accountId, {
          name: "First account support line",
          serverUrl: "https://first.example.invalid/hook",
          serverSecret: "first-account-webhook-secret",
          instructions: "Belongs to the first account.",
        }),
        createAssistant(first.accountId, {
          name: "First account sales line",
          instructions: "Also belongs to the first account.",
        }),
      ])

      firstAssistantIds = created.map((row) => String(row.id))

      const other = await createAssistant(second.accountId, {
        name: "Second account line",
        instructions: "Belongs to the second account.",
      })

      secondAssistantId = String(other.id)
    })

    afterAll(async () => {
      await closeDb()
    })

    it("gives the two signups different accounts", () => {
      expect(first.accountId).not.toBe(second.accountId)
      expect(first.userId).not.toBe(second.userId)
      expect(first.accountId).not.toBe("")
      expect(second.accountId).not.toBe("")
    })

    it("seeded rows the owner can actually read (control for every test below)", async () => {
      for (const id of firstAssistantIds) {
        const row = await getAssistantForAccount(first.accountId, id)

        expect(
          row,
          `the owning account cannot read its own assistant ${id}`
        ).not.toBeNull()
        expect(row?.accountId).toBe(first.accountId)
      }

      expect(firstAssistantIds).toHaveLength(2)
    })

    /**
     * The read that mutation C breaks. Remove the `accountId` predicate from
     * `getAssistantForAccount` and this returns the first account's row.
     */
    it("returns null when the second account fetches the first account’s assistant by id", async () => {
      for (const id of firstAssistantIds) {
        const row = await getAssistantForAccount(second.accountId, id)

        expect(row, `assistant ${id} leaked to the second account`).toBeNull()
      }
    })

    it('returns null rather than distinguishing "not yours" from "does not exist"', async () => {
      const notYours = await getAssistantForAccount(
        second.accountId,
        firstAssistantIds[0] ?? ""
      )
      const neverExisted = await getAssistantForAccount(
        second.accountId,
        "00000000-0000-4000-8000-000000000000"
      )

      expect(notYours).toBeNull()
      expect(neverExisted).toBeNull()
      expect(notYours).toStrictEqual(neverExisted)
    })

    /**
     * The read that mutation C breaks in the other function. Remove the predicate
     * from `listAssistantsForAccount` and the second account's list contains the
     * first account's rows.
     */
    it("lists only the second account’s own assistants", async () => {
      const listed = await listAssistantsForAccount(second.accountId)
      const listedIds = listed.map((row) => String(row.id))

      expect(listedIds).toStrictEqual([secondAssistantId])

      for (const id of firstAssistantIds) {
        expect(
          listedIds,
          `assistant ${id} leaked into the second account’s list`
        ).not.toContain(id)
      }

      for (const row of listed) {
        expect(row.accountId).toBe(second.accountId)
      }
    })

    it("lists only the first account’s own assistants (control)", async () => {
      const listed = await listAssistantsForAccount(first.accountId)
      const listedIds = listed.map((row) => String(row.id)).sort()

      expect(listedIds).toStrictEqual([...firstAssistantIds].sort())
      expect(listedIds).not.toContain(secondAssistantId)
    })

    it("never returns the first account’s data to a third, unrelated account", async () => {
      const third = await signUpNewAccount()

      expect(await listAssistantsForAccount(third.accountId)).toStrictEqual([])

      for (const id of [...firstAssistantIds, secondAssistantId]) {
        expect(await getAssistantForAccount(third.accountId, id)).toBeNull()
      }
    })

    /**
     * An empty or bogus account id must not act as a wildcard. A scoping bug that
     * turns `where account_id = ''` into "no predicate" would be invisible to the
     * tests above, which always pass a real account.
     */
    it.each([
      ["an empty account id", ""],
      ["an unknown account id", "no-such-account"],
    ])("returns nothing for %s", async (_label, accountId) => {
      expect(await listAssistantsForAccount(accountId)).toStrictEqual([])

      for (const id of firstAssistantIds) {
        expect(await getAssistantForAccount(accountId, id)).toBeNull()
      }
    })
  }
)
