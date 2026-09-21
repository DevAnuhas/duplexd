import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import type { SignedUpUser } from "./helpers/auth.ts"

const requestHeaders = { current: new Headers() }

vi.mock("next/headers", () => ({
  headers: async () => requestHeaders.current,
}))

const { GET: getCsrf } = await import("@/app/api/workspace/sandbox/csrf/route")
const { GET: getSamples, PUT: putSamples } =
  await import("@/app/api/workspace/sandbox/assistants/[id]/samples/route")
const { createAssistant, getAssistantForAccount, updateAssistantForAccount } =
  await import("@/data/assistants")
const { closeDb } = await import("@/db/client")
const { compilePracticeConfiguration, fingerprintToolInputSchema } =
  await import("@/practice/configuration")
const { signUpNewAccount } = await import("./helpers/auth.ts")
const { isDatabaseConfigured } = await import("./helpers/environment.ts")
const { PRACTICE_TOOL, practiceSampleDefinition } =
  await import("./helpers/practice.ts")

const describeDatabase = describe.skipIf(!isDatabaseConfigured())
const routeContext = (id: string) => ({ params: Promise.resolve({ id }) })

afterAll(async () => {
  await closeDb()
})

async function csrfFor(account: SignedUpUser): Promise<string> {
  requestHeaders.current = new Headers({ cookie: account.cookie })
  const response = await getCsrf()
  expect(response.status).toBe(200)
  expect(response.headers.get("cache-control")).toBe("no-store")
  const body = (await response.json()) as { token: string }
  return body.token
}

function putRequest(
  body: unknown,
  input: { origin?: string; csrf?: string; fetchSite?: string } = {}
): Request {
  const headers = new Headers({ "content-type": "application/json" })
  if (input.origin !== undefined) headers.set("origin", input.origin)
  if (input.csrf !== undefined) headers.set("x-duplexd-csrf", input.csrf)
  if (input.fetchSite !== undefined) {
    headers.set("sec-fetch-site", input.fetchSite)
  }
  return new Request(
    "http://localhost:3000/api/workspace/sandbox/assistants/id/samples",
    { method: "PUT", headers, body: JSON.stringify(body) }
  )
}

describeDatabase("account-scoped Practice sample routes", () => {
  let owner: SignedUpUser
  let intruder: SignedUpUser
  let assistantId = ""
  let definitions: ReturnType<typeof practiceSampleDefinition>[]

  beforeAll(async () => {
    owner = await signUpNewAccount()
    intruder = await signUpNewAccount()
    const assistant = await createAssistant(owner.accountId, {
      name: `sample route ${randomUUID()}`,
      tools: [PRACTICE_TOOL],
      serverUrl: "https://customer.example.invalid/trap",
      serverSecret: `customer-secret-${randomUUID()}`,
    })
    assistantId = assistant.id
    definitions = [
      practiceSampleDefinition(fingerprintToolInputSchema(PRACTICE_TOOL)),
    ]
  })

  it("requires a workspace session for reads and CSRF bootstrap", async () => {
    requestHeaders.current = new Headers()

    expect((await getCsrf()).status).toBe(401)
    expect(
      (
        await getSamples(
          new Request("http://localhost:3000"),
          routeContext(assistantId)
        )
      ).status
    ).toBe(401)
  })

  it("returns only the safe account-owned sample DTO", async () => {
    requestHeaders.current = new Headers({ cookie: owner.cookie })
    const response = await getSamples(
      new Request("http://localhost:3000"),
      routeContext(assistantId)
    )
    const body = (await response.json()) as Record<string, unknown>

    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(Object.keys(body).sort()).toStrictEqual([
      "assistantId",
      "assistantRevision",
      "definitions",
      "issues",
      "revision",
    ])
    expect(body).toMatchObject({
      assistantId,
      assistantRevision: 1,
      revision: 0,
      definitions: [],
      issues: [
        expect.objectContaining({
          field: "definitions",
          message: expect.stringContaining(PRACTICE_TOOL.name),
        }),
      ],
    })
    expect(JSON.stringify(body)).not.toContain("customer.example.invalid")
    expect(JSON.stringify(body)).not.toContain("customer-secret")
  })

  it("makes a foreign assistant indistinguishable from a missing one", async () => {
    requestHeaders.current = new Headers({ cookie: intruder.cookie })
    const foreign = await getSamples(
      new Request("http://localhost:3000"),
      routeContext(assistantId)
    )
    const absent = await getSamples(
      new Request("http://localhost:3000"),
      routeContext(randomUUID())
    )

    expect(foreign.status).toBe(404)
    expect(await foreign.text()).toBe(await absent.text())
  })

  it("rejects missing/mismatched Origin, cross-site metadata, and missing CSRF", async () => {
    const csrf = await csrfFor(owner)
    const body = { expectedRevision: 0, definitions }

    expect(
      (await putSamples(putRequest(body), routeContext(assistantId))).status
    ).toBe(403)
    expect(
      (
        await putSamples(
          putRequest(body, {
            origin: "https://evil.example.invalid",
            csrf,
          }),
          routeContext(assistantId)
        )
      ).status
    ).toBe(403)
    expect(
      (
        await putSamples(
          putRequest(body, {
            origin: "http://localhost:3000",
            csrf,
            fetchSite: "cross-site",
          }),
          routeContext(assistantId)
        )
      ).status
    ).toBe(403)
    expect(
      (
        await putSamples(
          putRequest(body, { origin: "http://localhost:3000" }),
          routeContext(assistantId)
        )
      ).status
    ).toBe(403)
  })

  it("saves with revision CAS and returns conflict on a stale write", async () => {
    const csrf = await csrfFor(owner)
    const request = () =>
      putRequest(
        { expectedRevision: 0, definitions },
        {
          origin: "http://localhost:3000",
          csrf,
          fetchSite: "same-origin",
        }
      )

    const saved = await putSamples(request(), routeContext(assistantId))
    expect(saved.status).toBe(200)
    expect(await saved.json()).toMatchObject({
      assistantId,
      assistantRevision: 1,
      revision: 1,
      definitions,
      issues: [],
    })

    const stale = await putSamples(request(), routeContext(assistantId))
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({
      code: "sample_revision_conflict",
      currentRevision: 1,
    })
  })

  it("does not allow a valid session and CSRF token to write another account's assistant", async () => {
    const csrf = await csrfFor(intruder)
    const response = await putSamples(
      putRequest(
        { expectedRevision: 0, definitions },
        {
          origin: "http://localhost:3000",
          csrf,
          fetchSite: "same-origin",
        }
      ),
      routeContext(assistantId)
    )

    expect(response.status).toBe(404)
  })

  it("retains stale authored samples and blocks compilation until explicit review", async () => {
    const assistant = await createAssistant(owner.accountId, {
      name: `stale sample route ${randomUUID()}`,
      voice: "marin",
      accentStyle: "Warm and direct.",
      instructions: "Answer from synthetic property data.",
      backendInstructions: "Use the declared property tool.",
      backendModel: "gpt-5.6-luna",
      waitingBehavior: "Acknowledge once.",
      tools: [PRACTICE_TOOL],
    })
    const originalDefinitions = [
      practiceSampleDefinition(fingerprintToolInputSchema(PRACTICE_TOOL)),
    ]
    const csrf = await csrfFor(owner)
    const saved = await putSamples(
      putRequest(
        { expectedRevision: 0, definitions: originalDefinitions },
        {
          origin: "http://localhost:3000",
          csrf,
          fetchSite: "same-origin",
        }
      ),
      routeContext(assistant.id)
    )
    expect(saved.status).toBe(200)

    const changedTool = {
      ...structuredClone(PRACTICE_TOOL),
      name: "lookup_property_v2",
      parameters: {
        type: "object",
        properties: { propertyId: { type: "integer" } },
        required: ["propertyId"],
        additionalProperties: false,
      },
    }
    const updated = await updateAssistantForAccount(
      owner.accountId,
      assistant.id,
      {
        name: assistant.name,
        voice: assistant.voice,
        accentStyle: assistant.accentStyle,
        instructions: assistant.instructions,
        backendInstructions: assistant.backendInstructions,
        backendModel: assistant.backendModel,
        waitingBehavior: assistant.waitingBehavior,
        tools: [changedTool],
      },
      assistant.revision
    )
    expect(updated).toMatchObject({ kind: "updated" })

    requestHeaders.current = new Headers({ cookie: owner.cookie })
    const staleResponse = await getSamples(
      new Request("http://localhost:3000"),
      routeContext(assistant.id)
    )
    expect(staleResponse.status).toBe(200)
    const stale = (await staleResponse.json()) as {
      assistantRevision: number
      revision: number
      definitions: typeof originalDefinitions
      issues: Array<{ field: string; message: string }>
    }
    expect(stale).toMatchObject({
      assistantRevision: 2,
      revision: 1,
      definitions: originalDefinitions,
    })
    expect(stale.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "definitions",
          message: expect.stringMatching(
            /not present|review|needs an explicit/i
          ),
        }),
      ])
    )
    expect(JSON.stringify(stale.definitions)).toContain("Sample Cottage")
    expect(JSON.stringify(stale.definitions)).toContain("unavailable")

    const current = await getAssistantForAccount(owner.accountId, assistant.id)
    expect(current).not.toBeNull()
    if (current === null) throw new Error("updated assistant disappeared")
    const blocked = compilePracticeConfiguration({
      assistant: current,
      baseRevision: current.revision,
      source: "saved",
      samples: stale.definitions,
      sampleRevision: stale.revision,
    })
    expect(blocked).toMatchObject({ kind: "invalid" })

    const reviewedDefinitions = [
      {
        ...practiceSampleDefinition(fingerprintToolInputSchema(changedTool)),
        toolName: changedTool.name,
      },
    ]
    const reviewedResponse = await putSamples(
      putRequest(
        { expectedRevision: stale.revision, definitions: reviewedDefinitions },
        {
          origin: "http://localhost:3000",
          csrf,
          fetchSite: "same-origin",
        }
      ),
      routeContext(assistant.id)
    )
    expect(reviewedResponse.status).toBe(200)
    expect(await reviewedResponse.json()).toMatchObject({ issues: [] })

    expect(
      compilePracticeConfiguration({
        assistant: current,
        baseRevision: current.revision,
        source: "saved",
        samples: reviewedDefinitions,
        sampleRevision: stale.revision + 1,
      })
    ).toMatchObject({ kind: "ready" })
  })
})
