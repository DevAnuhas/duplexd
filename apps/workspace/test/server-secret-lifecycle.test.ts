import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import type { SignedUpUser } from "./helpers/auth.ts"

/**
 * The customer's webhook secret, over its whole life: set, left alone, replaced,
 * cleared.
 *
 * P02 proved the secret is encrypted at rest. P03 builds the surface that can
 * destroy it, and that is the new risk: an edit form that submits every field
 * will submit an empty secret box on every unrelated save, and a naive update
 * would blank a working credential because somebody renamed an assistant.
 *
 * So the three cases here are asserted as **stored state**, read over raw SQL
 * rather than through the projection under test:
 *
 *  - an empty secret field leaves the stored ciphertext **byte-identical**;
 *  - a supplied secret replaces it, and the stored entry decrypts to the new
 *    value — which is what stops "unchanged on empty" being achieved by
 *    ignoring the field altogether;
 *  - clearing is an explicit act and empties it.
 *
 * And throughout: the read projection returns `hasServerSecret` as a boolean
 * and no secret field at all. The key set is asserted exactly, so adding
 * `serverSecrets` to `publicColumns` fails this file rather than passing a
 * check that only looked for plaintext.
 */

const requestHeaders = { current: new Headers() }

vi.mock("next/headers", () => ({
  headers: async () => requestHeaders.current,
}))

vi.mock("next/cache", () => ({
  revalidatePath: () => undefined,
}))

const { closeDb } = await import("@/db/client")
const { createAssistantAction, updateAssistantAction } =
  await import("@/app/actions")
const { getAssistantForAccount, listAssistantsForAccount } =
  await import("@/data/assistants")
const { decryptSecret } = await import("@/lib/crypto")
const { signUpNewAccount } = await import("./helpers/auth.ts")
const { withTestPool } = await import("./helpers/database.ts")
const { isDatabaseConfigured } = await import("./helpers/environment.ts")

/**
 * Exactly what a read path may return. Asserted as an exact set rather than as
 * "does not contain a secret": a projection is allowed to grow, and the moment
 * it grows silently the next column to arrive could be the ciphertext.
 */
const PUBLIC_COLUMNS = [
  "accentStyle",
  "accountId",
  "backendInstructions",
  "backendModel",
  "createdAt",
  "hasServerSecret",
  "id",
  "instructions",
  "name",
  "revision",
  "serverUrl",
  "tools",
  "updatedAt",
  "voice",
  "waitingBehavior",
] as const

type SecretEntry = { id: string; ciphertext: string }

function formDataFor(fields: Record<string, string>): FormData {
  const formData = new FormData()

  for (const [key, value] of Object.entries(fields)) {
    formData.set(key, value)
  }

  return formData
}

const describeDatabase = describe.skipIf(!isDatabaseConfigured())

afterAll(async () => {
  await closeDb()
})

describeDatabase("a secret set through the real create action", () => {
  /** Unique per run, so a leak an earlier run left behind cannot keep this one red. */
  const CANARY = `canary-action-secret-${randomUUID()}`
  const REPLACEMENT = `canary-replacement-secret-${randomUUID()}`

  let account: SignedUpUser
  let assistantId = ""
  const name = `secret bearer ${randomUUID()}`

  /** Every field the form submits, so an edit is a realistic full submission. */
  const fields = {
    name,
    voice: "aura-2-thalia",
    accentStyle: "warm, west-coast American",
    instructions: "You answer for a bike shop.",
    backendInstructions: "Prefer the orders tool.",
    backendModel: "gpt-4.1-mini",
    waitingBehavior: 'Say "one moment" if a tool is slow.',
    serverUrl: "https://hooks.example.invalid/inbound",
  }

  beforeAll(async () => {
    account = await signUpNewAccount()
    requestHeaders.current = new Headers({ cookie: account.cookie })

    const result = await createAssistantAction(
      formDataFor({ ...fields, serverSecret: CANARY })
    )

    expect(result, "the assistant under test was not created").toStrictEqual({
      ok: true,
      assistantId: expect.any(String),
    })

    const saved = (await listAssistantsForAccount(account.accountId)).find(
      (row) => row.name === name
    )

    assistantId = String(saved?.id)
  })

  /** The stored `server_secrets` list, read over raw SQL. */
  async function storedSecrets(): Promise<SecretEntry[]> {
    return withTestPool(async (pool) => {
      const { rows } = await pool.query<{ server_secrets: SecretEntry[] }>(
        "SELECT server_secrets FROM assistants WHERE id = $1",
        [assistantId]
      )

      expect(rows[0], "the assistant row is gone").toBeDefined()

      return rows[0]?.server_secrets ?? []
    })
  }

  async function updateCurrent(
    submitted: Record<string, string>
  ): ReturnType<typeof updateAssistantAction> {
    const current = await getAssistantForAccount(account.accountId, assistantId)

    expect(current, "the assistant to update is gone").not.toBeNull()
    return updateAssistantAction(
      assistantId,
      formDataFor({
        ...submitted,
        expectedRevision: String(current?.revision),
      })
    )
  }

  it("wrote one encrypted entry that decrypts to what was typed", async () => {
    const secrets = await storedSecrets()

    expect(secrets).toHaveLength(1)
    expect(secrets[0]?.ciphertext).toMatch(/^v1\./)
    expect(secrets[0]?.ciphertext).not.toContain(CANARY)
    expect(decryptSecret(secrets[0]?.ciphertext ?? "")).toBe(CANARY)
  })

  /**
   * The whole-database sweep. Not "the assistants row has no plaintext" — every
   * table, every column, rendered as text, so a leak into an audit row or a
   * snapshot is caught too.
   */
  it("has the plaintext in no row of any table", async () => {
    const hits = await withTestPool(async (pool) => {
      const { rows: tables } = await pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
      )

      const found: string[] = []

      for (const { table_name } of tables) {
        const { rows } = await pool.query<{ hits: string }>(
          `SELECT count(*)::text AS hits FROM "${table_name}" t
           WHERE to_jsonb(t)::text LIKE $1`,
          [`%${CANARY}%`]
        )

        if (Number(rows[0]?.hits ?? 0) > 0) {
          found.push(table_name)
        }
      }

      return found
    })

    expect(hits).toStrictEqual([])
  })

  describe("what a read path returns", () => {
    it("returns exactly the public columns and no secret field", async () => {
      const single = (await getAssistantForAccount(
        account.accountId,
        assistantId
      )) as Record<string, unknown> | null

      expect(single).not.toBeNull()
      expect(Object.keys(single ?? {}).sort()).toStrictEqual([
        ...PUBLIC_COLUMNS,
      ])
      expect(single).not.toHaveProperty("serverSecrets")
      expect(single).not.toHaveProperty("server_secrets")
      expect(JSON.stringify(single)).not.toContain(CANARY)
      expect(JSON.stringify(single)).not.toContain("v1.")
    })

    it("returns exactly the public columns from the list too", async () => {
      const listed = (await listAssistantsForAccount(
        account.accountId
      )) as unknown as Record<string, unknown>[]

      expect(listed.length).toBeGreaterThan(0)

      for (const row of listed) {
        expect(Object.keys(row).sort()).toStrictEqual([...PUBLIC_COLUMNS])
      }

      expect(JSON.stringify(listed)).not.toContain(CANARY)
      expect(JSON.stringify(listed)).not.toContain("v1.")
    })

    /**
     * A boolean, and nothing more. Not a masked value of the real length, not a
     * placeholder that round-trips as if it were the secret — the rubric is
     * explicit that a field which looks like it round-trips when it does not is
     * a correctness problem wearing a design costume.
     */
    it("says whether a secret is set as a boolean", async () => {
      const row = await getAssistantForAccount(account.accountId, assistantId)

      expect(typeof row?.hasServerSecret).toBe("boolean")
      expect(row?.hasServerSecret).toBe(true)
    })

    it("says false for an assistant with no secret", async () => {
      const other = `no secret ${randomUUID()}`

      await createAssistantAction(formDataFor({ name: other }))

      const row = (await listAssistantsForAccount(account.accountId)).find(
        (entry) => entry.name === other
      )

      expect(typeof row?.hasServerSecret).toBe("boolean")
      expect(row?.hasServerSecret).toBe(false)
    })
  })

  /**
   * The case that destroys a customer's credential if it is wrong. An edit form
   * submits every field, so an unrelated rename arrives with an empty secret
   * box — which means "I did not type anything", never "delete it".
   */
  it("leaves the stored ciphertext byte-identical when the secret field is empty", async () => {
    const before = await storedSecrets()

    const result = await updateCurrent({
      ...fields,
      name: `${name} renamed`,
      serverSecret: "",
    })

    expect(result).toMatchObject({ ok: true })

    const after = await storedSecrets()

    expect(after).toStrictEqual(before)
    expect(after[0]?.ciphertext).toBe(before[0]?.ciphertext)
    expect(decryptSecret(after[0]?.ciphertext ?? "")).toBe(CANARY)
    expect(
      (await getAssistantForAccount(account.accountId, assistantId))
        ?.hasServerSecret
    ).toBe(true)
  })

  it("leaves it byte-identical when the field is absent from the submission", async () => {
    const before = await storedSecrets()

    await updateCurrent({ ...fields, name })

    expect(await storedSecrets()).toStrictEqual(before)
  })

  /**
   * The sibling of the case above, and the reason it is not satisfied by
   * ignoring the field entirely: a supplied secret must genuinely replace the
   * stored one and decrypt to the new value.
   */
  it("replaces the stored ciphertext when a new secret is supplied", async () => {
    const before = await storedSecrets()

    const result = await updateCurrent({
      ...fields,
      name,
      serverSecret: REPLACEMENT,
    })

    expect(result).toMatchObject({ ok: true })

    const after = await storedSecrets()

    expect(after).toHaveLength(1)
    expect(after[0]?.ciphertext).not.toBe(before[0]?.ciphertext)
    expect(decryptSecret(after[0]?.ciphertext ?? "")).toBe(REPLACEMENT)
    expect(
      (await getAssistantForAccount(account.accountId, assistantId))
        ?.hasServerSecret
    ).toBe(true)
  })

  it("keeps the replacement out of every read path", async () => {
    const single = await getAssistantForAccount(account.accountId, assistantId)
    const listed = await listAssistantsForAccount(account.accountId)

    expect(JSON.stringify(single)).not.toContain(REPLACEMENT)
    expect(JSON.stringify(listed)).not.toContain(REPLACEMENT)
  })

  /**
   * Clearing is an explicit act — the checkbox, never the side effect of an
   * empty field. The two tests above prove the empty field does not clear; this
   * proves the checkbox does, so "never clears" is not how they pass.
   */
  it("empties the secret when the clear checkbox is ticked", async () => {
    expect(await storedSecrets()).toHaveLength(1)

    const result = await updateCurrent({
      ...fields,
      name,
      serverSecret: "",
      clearServerSecret: "on",
    })

    expect(result).toMatchObject({ ok: true })
    expect(await storedSecrets()).toStrictEqual([])
    expect(
      (await getAssistantForAccount(account.accountId, assistantId))
        ?.hasServerSecret
    ).toBe(false)
  })

  it("sets a fresh secret on an assistant that has none", async () => {
    const third = `canary-third-secret-${randomUUID()}`

    await updateCurrent({ ...fields, name, serverSecret: third })

    const secrets = await storedSecrets()

    expect(secrets).toHaveLength(1)
    expect(decryptSecret(secrets[0]?.ciphertext ?? "")).toBe(third)
    expect(
      (await getAssistantForAccount(account.accountId, assistantId))
        ?.hasServerSecret
    ).toBe(true)
  })

  /**
   * Both at once is ambiguous input, so the resolution is pinned rather than
   * left to chance: a typed secret is an explicit instruction to store *this*,
   * and it wins over the clear. Pinned so a future change to that precedence is
   * a deliberate one.
   */
  it("prefers a supplied secret over the clear checkbox when both arrive", async () => {
    const both = `canary-both-${randomUUID()}`

    await updateCurrent({
      ...fields,
      name,
      serverSecret: both,
      clearServerSecret: "on",
    })

    const secrets = await storedSecrets()

    expect(secrets).toHaveLength(1)
    expect(decryptSecret(secrets[0]?.ciphertext ?? "")).toBe(both)
  })
})
