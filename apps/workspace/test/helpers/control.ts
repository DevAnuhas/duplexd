import { randomUUID } from "node:crypto"

import { expect } from "vitest"

export const COMPLETE_ASSISTANT_FIELDS = {
  voice: "marin",
  accentStyle: "Use a neutral synthetic accent.",
  instructions: "Help the caller with synthetic test data only.",
  backendInstructions: "Choose only the declared synthetic tools.",
  backendModel: "gpt-test-responses",
  waitingBehavior: "Acknowledge work before waiting.",
  serverUrl: "https://customer.example.invalid/tools",
  serverSecret: "synthetic-webhook-secret-never-use",
} as const

export const FLAT_TOOL_WITH_IGNORED_KEY = {
  name: "lookup_invoice",
  description: "Looks up a synthetic invoice.",
  parameters: {
    type: "object",
    properties: { email: { type: "string" } },
    required: ["email"],
  },
  ignoredByAgentProjection: "must not cross the config boundary",
} as const

export function assistantFormData(
  overrides: Record<string, string | undefined> = {}
): FormData {
  const fields: Record<string, string | undefined> = {
    name: `P05 assistant ${randomUUID()}`,
    ...COMPLETE_ASSISTANT_FIELDS,
    tools: JSON.stringify([FLAT_TOOL_WITH_IGNORED_KEY]),
    ...overrides,
  }
  const form = new FormData()

  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      form.set(key, value)
    }
  }

  return form
}

export function bearer(raw: string): Headers {
  return new Headers({
    authorization: `Bearer ${raw}`,
    "content-type": "application/json",
  })
}

export type ProblemDocument = {
  type: string
  title: string
  status: number
  code: string
  detail: string
}

export async function expectProblem(
  response: Response,
  status: number,
  code: string
): Promise<ProblemDocument> {
  expect(response.status).toBe(status)
  expect(response.headers.get("content-type")).toContain(
    "application/problem+json"
  )

  const body = (await response.json()) as ProblemDocument

  expect(body.status).toBe(status)
  expect(body.code).toBe(code)
  expect(body.type).toBe(`https://duplexd.dev/problems/${code}`)
  expect(body.detail).toBe(body.title)
  expect(body.detail).not.toBe("")

  return body
}

export function providerToken(expirySeconds: number): string {
  const payload = Buffer.from(
    JSON.stringify({ exp: expirySeconds }),
    "utf8"
  ).toString("base64url")

  return `synthetic-header.${payload}.synthetic-signature`
}
