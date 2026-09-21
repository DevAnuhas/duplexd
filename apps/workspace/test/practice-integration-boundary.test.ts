import { randomUUID } from "node:crypto"

import { afterAll, describe, expect, it } from "vitest"

const { prepareCallCreation } = await import("@/data/calls")
const { createAssistant } = await import("@/data/assistants")
const { closeDb } = await import("@/db/client")
const { MAX_PRACTICE_TOOLS, validateRunnableAssistant } =
  await import("@/practice/configuration")
const { signUpNewAccount } = await import("./helpers/auth.ts")
const { isDatabaseConfigured } = await import("./helpers/environment.ts")

const describeDatabase = describe.skipIf(!isDatabaseConfigured())

afterAll(async () => {
  await closeDb()
})

describeDatabase("Practice-only tool-count bound", () => {
  it("keeps 33 valid tools runnable for integration while Practice rejects them", async () => {
    const account = await signUpNewAccount()
    const tools = Array.from(
      { length: MAX_PRACTICE_TOOLS + 1 },
      (_, index) => ({
        name: `lookup_${index}`,
        description: `Looks up synthetic field ${index}.`,
        parameters: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
      })
    )
    const assistant = await createAssistant(account.accountId, {
      name: `33-tool integration ${randomUUID()}`,
      voice: "marin",
      accentStyle: "Neutral.",
      instructions: "Use the declared integration tools.",
      backendInstructions: "Choose the correct integration tool.",
      backendModel: "gpt-5.6-luna",
      waitingBehavior: "Acknowledge once.",
      serverUrl: "https://customer.example.invalid/tools",
      serverSecret: `integration-secret-${randomUUID()}`,
      tools,
    })

    const integration = await prepareCallCreation(
      account.accountId,
      assistant.id
    )
    expect(integration.kind).toBe("ready")
    if (integration.kind !== "ready") {
      throw new Error(`integration rejected: ${JSON.stringify(integration)}`)
    }
    expect(integration.snapshot.tools).toHaveLength(MAX_PRACTICE_TOOLS + 1)

    expect(validateRunnableAssistant(assistant, "integration")).toStrictEqual(
      []
    )
    expect(validateRunnableAssistant(assistant, "practice")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "tools",
          message: expect.stringContaining(String(MAX_PRACTICE_TOOLS)),
        }),
      ])
    )
  })
})
