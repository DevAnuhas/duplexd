import { randomUUID } from "node:crypto"

import { afterAll, describe, expect, it } from "vitest"

const { closeDb } = await import("@/db/client")
const {
  archiveAssistantForAccount,
  createAssistant,
  getAssistantForAccount,
  updateAssistantForAccount,
} = await import("@/data/assistants")
const { signUpNewAccount } = await import("./helpers/auth.ts")
const { isDatabaseConfigured } = await import("./helpers/environment.ts")

const describeDatabase = describe.skipIf(!isDatabaseConfigured())

afterAll(async () => {
  await closeDb()
})

describeDatabase("assistant revision compare-and-swap", () => {
  it("increments on update and rejects a stale writer without changing data", async () => {
    const account = await signUpNewAccount()
    const created = await createAssistant(account.accountId, {
      name: `CAS ${randomUUID()}`,
      instructions: "Original instructions.",
    })

    expect(created.revision).toBe(1)
    const first = await updateAssistantForAccount(
      account.accountId,
      created.id,
      { name: created.name, instructions: "First writer won." },
      created.revision
    )

    expect(first).toMatchObject({
      kind: "updated",
      assistant: { revision: 2, instructions: "First writer won." },
    })

    const stale = await updateAssistantForAccount(
      account.accountId,
      created.id,
      { name: created.name, instructions: "Stale writer overwrote it." },
      created.revision
    )

    expect(stale).toStrictEqual({ kind: "conflict", currentRevision: 2 })
    expect(
      await getAssistantForAccount(account.accountId, created.id)
    ).toMatchObject({ revision: 2, instructions: "First writer won." })
  })

  it("rejects stale archive and permits archive at the current revision", async () => {
    const account = await signUpNewAccount()
    const created = await createAssistant(account.accountId, {
      name: `archive CAS ${randomUUID()}`,
    })
    const updated = await updateAssistantForAccount(
      account.accountId,
      created.id,
      { name: `${created.name} updated` },
      created.revision
    )
    if (updated.kind !== "updated") throw new Error("expected update")

    expect(
      await archiveAssistantForAccount(
        account.accountId,
        created.id,
        created.revision
      )
    ).toStrictEqual({ kind: "conflict", currentRevision: 2 })
    expect(
      await getAssistantForAccount(account.accountId, created.id)
    ).not.toBeNull()

    expect(
      await archiveAssistantForAccount(
        account.accountId,
        created.id,
        updated.assistant.revision
      )
    ).toStrictEqual({ kind: "archived" })
    expect(
      await getAssistantForAccount(account.accountId, created.id)
    ).toBeNull()
  })

  it("does not reveal another account's current revision", async () => {
    const owner = await signUpNewAccount()
    const intruder = await signUpNewAccount()
    const created = await createAssistant(owner.accountId, {
      name: `owned CAS ${randomUUID()}`,
    })

    expect(
      await updateAssistantForAccount(
        intruder.accountId,
        created.id,
        { name: "intruder" },
        created.revision
      )
    ).toStrictEqual({ kind: "not_found" })
    expect(
      await archiveAssistantForAccount(
        intruder.accountId,
        created.id,
        created.revision
      )
    ).toStrictEqual({ kind: "not_found" })
    expect(
      await getAssistantForAccount(owner.accountId, created.id)
    ).toMatchObject({ name: created.name, revision: 1 })
  })
})
