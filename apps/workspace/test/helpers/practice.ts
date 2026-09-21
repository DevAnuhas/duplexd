import { createHmac, randomUUID } from "node:crypto"

export const PRACTICE_TOOL = {
  name: "lookup_property",
  description: "Looks up synthetic information about a sample property.",
  parameters: {
    type: "object",
    properties: {
      property: { type: "string" },
    },
    required: ["property"],
    additionalProperties: false,
  },
} as const

export const SECOND_PRACTICE_TOOL = {
  name: "check_amenity",
  description: "Checks a synthetic amenity at a sample property.",
  parameters: {
    type: "object",
    properties: {
      amenity: { type: "string" },
    },
    required: ["amenity"],
    additionalProperties: false,
  },
} as const

export function practiceSampleDefinition(fingerprint: string) {
  return {
    toolName: PRACTICE_TOOL.name,
    inputSchemaFingerprint: fingerprint,
    reviewedFingerprint: fingerprint,
    defaultResult: {
      property: "Sample Cottage",
      checkoutTime: "11:00 AM",
    },
    overrides: [
      {
        name: "unavailable",
        result: { message: "Sample information unavailable." },
      },
    ],
  }
}

export type PracticeWebhookBody = {
  tool: string
  arguments: unknown
  callId: string
  assistantId: string
  invocationId: string
}

export function practiceWebhookBody(
  overrides: Partial<PracticeWebhookBody> = {}
): PracticeWebhookBody {
  return {
    tool: PRACTICE_TOOL.name,
    arguments: { property: "sample-cottage" },
    callId: `call-${randomUUID()}`,
    assistantId: `assistant-${randomUUID()}`,
    invocationId: `invocation-${randomUUID()}`,
    ...overrides,
  }
}

export function practiceSignature(
  secret: string,
  timestamp: string,
  rawBody: string
): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex")
}

export function practiceWebhookHeaders(input: {
  secret: string
  timestamp: string
  rawBody: string
  callId: string
  assistantId: string
  invocationId: string
}): Headers {
  return new Headers({
    "content-type": "application/json",
    "duplexd-signature": `t=${input.timestamp},v1=${practiceSignature(
      input.secret,
      input.timestamp,
      input.rawBody
    )}`,
    "duplexd-call-id": input.callId,
    "duplexd-assistant-id": input.assistantId,
    "duplexd-invocation-id": input.invocationId,
  })
}
