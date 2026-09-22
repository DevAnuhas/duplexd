import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto"

import { and, count, eq, isNull } from "drizzle-orm"

import { getDb } from "@/db/client"
import {
  assistantSamples,
  assistants,
  calls,
  practiceInvocations,
} from "@/db/schema"
import { decryptSecret, encryptSecret } from "@/lib/crypto"
import type { ValidationIssue } from "@/lib/validate"
import { lockPracticeExecution } from "@/sandbox/execution"

import {
  canonicalJson,
  fingerprintToolInputSchema,
  projectAssistantTools,
  validatePracticeArguments,
  type FrozenPracticeSnapshot,
  type JsonValue,
  type PracticeSampleDefinition,
} from "./configuration"

export const MAX_SAMPLE_DEFINITIONS_BYTES = 64 * 1024
export const MAX_SAMPLE_RESULT_BYTES = 16 * 1024
export const MAX_PRACTICE_WEBHOOK_BYTES = 64 * 1024
export const MAX_PRACTICE_INVOCATIONS = 100
export const PRACTICE_SIGNATURE_TOLERANCE_SECONDS = 60
export const PRACTICE_SLOW_DELAY_MS = 1_000

export type AssistantSamplesDto = {
  assistantId: string
  assistantRevision: number
  revision: number
  definitions: PracticeSampleDefinition[]
  issues: ValidationIssue[]
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true
  }
  if (typeof value === "number") return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (typeof value !== "object") return false
  return Object.entries(value).every(
    ([, child]) => child !== undefined && isJsonValue(child)
  )
}

function utf8Bytes(value: unknown): number {
  return Buffer.byteLength(canonicalJson(value), "utf8")
}

export function decodeStoredPracticeSamples(value: unknown): {
  definitions: PracticeSampleDefinition[]
  issues: ValidationIssue[]
} {
  if (!Array.isArray(value)) {
    return {
      definitions: [],
      issues: [{ field: "definitions", message: "Samples must be a list." }],
    }
  }
  if (utf8Bytes(value) > MAX_SAMPLE_DEFINITIONS_BYTES) {
    return {
      definitions: [],
      issues: [
        {
          field: "definitions",
          message: `Samples must fit within ${MAX_SAMPLE_DEFINITIONS_BYTES} bytes.`,
        },
      ],
    }
  }

  const issues: ValidationIssue[] = []
  const definitions: PracticeSampleDefinition[] = []
  const seenTools = new Set<string>()

  value.forEach((candidate, index) => {
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      issues.push({
        field: "definitions",
        message: `Sample ${index + 1} must be an object.`,
      })
      return
    }
    const record = candidate as Record<string, unknown>
    if (
      Object.keys(record).some(
        (key) =>
          ![
            "toolName",
            "inputSchemaFingerprint",
            "reviewedFingerprint",
            "defaultResult",
            "overrides",
          ].includes(key)
      )
    ) {
      issues.push({
        field: "definitions",
        message: `Sample ${index + 1} contains an unsupported field.`,
      })
      return
    }

    const toolName = record.toolName
    if (
      typeof toolName !== "string" ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(toolName)
    ) {
      issues.push({
        field: "definitions",
        message: `Sample ${index + 1} has an invalid tool name.`,
      })
      return
    }
    if (seenTools.has(toolName)) {
      issues.push({
        field: "definitions",
        message: `Tool "${toolName}" has more than one sample definition.`,
      })
      return
    }
    seenTools.add(toolName)

    if (
      typeof record.inputSchemaFingerprint !== "string" ||
      !/^[0-9a-f]{64}$/.test(record.inputSchemaFingerprint) ||
      typeof record.reviewedFingerprint !== "string" ||
      !/^[0-9a-f]{64}$/.test(record.reviewedFingerprint)
    ) {
      issues.push({
        field: "definitions",
        message: `Tool "${toolName}" has an invalid schema fingerprint.`,
      })
      return
    }
    if (!isJsonValue(record.defaultResult)) {
      issues.push({
        field: "definitions",
        message: `Tool "${toolName}" needs an explicit JSON default result.`,
      })
      return
    }
    if (utf8Bytes(record.defaultResult) > MAX_SAMPLE_RESULT_BYTES) {
      issues.push({
        field: "definitions",
        message: `Tool "${toolName}" default result exceeds ${MAX_SAMPLE_RESULT_BYTES} bytes.`,
      })
      return
    }
    if (!Array.isArray(record.overrides)) {
      issues.push({
        field: "definitions",
        message: `Tool "${toolName}" overrides must be a list.`,
      })
      return
    }

    const overrideNames = new Set<string>()
    const overrides: PracticeSampleDefinition["overrides"] = []
    for (const override of record.overrides) {
      if (
        override === null ||
        typeof override !== "object" ||
        Array.isArray(override)
      ) {
        issues.push({
          field: "definitions",
          message: `Tool "${toolName}" has an invalid override.`,
        })
        continue
      }
      const overrideRecord = override as Record<string, unknown>
      if (
        Object.keys(overrideRecord).some(
          (key) => !["name", "result"].includes(key)
        ) ||
        typeof overrideRecord.name !== "string" ||
        !/^[a-zA-Z0-9_-]{1,64}$/.test(overrideRecord.name) ||
        !isJsonValue(overrideRecord.result) ||
        utf8Bytes(overrideRecord.result) > MAX_SAMPLE_RESULT_BYTES ||
        overrideNames.has(overrideRecord.name)
      ) {
        issues.push({
          field: "definitions",
          message: `Tool "${toolName}" has an invalid or duplicate override.`,
        })
        continue
      }
      overrideNames.add(overrideRecord.name)
      overrides.push({
        name: overrideRecord.name,
        result: structuredClone(overrideRecord.result),
      })
    }

    definitions.push({
      toolName,
      inputSchemaFingerprint: record.inputSchemaFingerprint,
      reviewedFingerprint: record.reviewedFingerprint,
      defaultResult: structuredClone(record.defaultResult),
      overrides,
    })
  })

  return { definitions, issues }
}

function sampleMappingIssues(
  definitions: PracticeSampleDefinition[],
  toolsValue: unknown
): ValidationIssue[] {
  const tools = projectAssistantTools(toolsValue)
  if (tools === null) {
    return [{ field: "definitions", message: "Assistant tools are not valid." }]
  }

  const issues: ValidationIssue[] = []
  for (const definition of definitions) {
    const tool = tools.find(
      (candidateTool) => candidateTool.name === definition.toolName
    )
    if (tool === undefined) {
      issues.push({
        field: "definitions",
        message: `Sample tool "${definition.toolName}" is not present in this configuration.`,
      })
      continue
    }
    const fingerprint = fingerprintToolInputSchema(tool)
    if (
      definition.inputSchemaFingerprint !== fingerprint ||
      definition.reviewedFingerprint !== fingerprint
    ) {
      issues.push({
        field: "definitions",
        message: `Tool "${tool.name}" changed its name or input schema; review its samples again.`,
      })
    }
  }
  for (const tool of tools) {
    if (!definitions.some((definition) => definition.toolName === tool.name)) {
      issues.push({
        field: "definitions",
        message: `Tool "${tool.name}" needs an explicit default sample result.`,
      })
    }
  }
  return issues
}

export function parsePracticeSampleDefinitions(
  value: unknown,
  toolsValue: unknown
):
  | { ok: true; definitions: PracticeSampleDefinition[] }
  | { ok: false; issues: ValidationIssue[] } {
  const decoded = decodeStoredPracticeSamples(value)
  const issues =
    decoded.issues.length > 0
      ? decoded.issues
      : sampleMappingIssues(decoded.definitions, toolsValue)
  return issues.length > 0
    ? { ok: false, issues }
    : { ok: true, definitions: decoded.definitions }
}

export async function getAssistantSamplesForAccount(
  accountId: string,
  assistantId: string
): Promise<AssistantSamplesDto | null> {
  const rows = await getDb()
    .select({
      assistantId: assistants.id,
      assistantRevision: assistants.revision,
      tools: assistants.tools,
      sampleRevision: assistantSamples.revision,
      definitions: assistantSamples.definitions,
    })
    .from(assistants)
    .leftJoin(
      assistantSamples,
      and(
        eq(assistantSamples.assistantId, assistants.id),
        eq(assistantSamples.accountId, accountId)
      )
    )
    .where(
      and(
        eq(assistants.id, assistantId),
        eq(assistants.accountId, accountId),
        isNull(assistants.archivedAt)
      )
    )
    .limit(1)
  const row = rows[0]
  if (row === undefined) return null

  const decoded = decodeStoredPracticeSamples(row.definitions ?? [])
  const issues = [
    ...decoded.issues,
    ...sampleMappingIssues(decoded.definitions, row.tools),
  ]
  return {
    assistantId: row.assistantId,
    assistantRevision: row.assistantRevision,
    revision: row.sampleRevision ?? 0,
    definitions: decoded.definitions,
    issues,
  }
}

export type SaveAssistantSamplesResult =
  | { kind: "not_found" }
  | { kind: "conflict"; currentRevision: number }
  | { kind: "invalid"; issues: ValidationIssue[] }
  | { kind: "saved"; samples: AssistantSamplesDto }

export async function saveAssistantSamplesForAccount(
  accountId: string,
  assistantId: string,
  expectedRevision: number,
  value: unknown
): Promise<SaveAssistantSamplesResult> {
  return getDb().transaction(async (tx) => {
    const assistantRows = await tx
      .select({
        id: assistants.id,
        revision: assistants.revision,
        tools: assistants.tools,
      })
      .from(assistants)
      .where(
        and(
          eq(assistants.id, assistantId),
          eq(assistants.accountId, accountId),
          isNull(assistants.archivedAt)
        )
      )
      .limit(1)
      .for("update")
    const assistant = assistantRows[0]
    if (assistant === undefined) return { kind: "not_found" } as const

    const parsed = parsePracticeSampleDefinitions(value, assistant.tools)
    if (!parsed.ok) return { kind: "invalid", issues: parsed.issues } as const

    const existingRows = await tx
      .select({ revision: assistantSamples.revision })
      .from(assistantSamples)
      .where(
        and(
          eq(assistantSamples.assistantId, assistantId),
          eq(assistantSamples.accountId, accountId)
        )
      )
      .limit(1)
    const currentRevision = existingRows[0]?.revision ?? 0
    if (currentRevision !== expectedRevision) {
      return { kind: "conflict", currentRevision } as const
    }

    const revision = currentRevision + 1
    if (currentRevision === 0) {
      await tx.insert(assistantSamples).values({
        assistantId,
        accountId,
        revision,
        definitions: parsed.definitions,
      })
    } else {
      await tx
        .update(assistantSamples)
        .set({
          revision,
          definitions: parsed.definitions,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(assistantSamples.assistantId, assistantId),
            eq(assistantSamples.accountId, accountId),
            eq(assistantSamples.revision, currentRevision)
          )
        )
    }

    return {
      kind: "saved",
      samples: {
        assistantId,
        assistantRevision: assistant.revision,
        revision,
        definitions: parsed.definitions,
        issues: [],
      },
    } as const
  })
}

export function createPracticeSecret(): {
  plaintext: string
  ciphertext: string
} {
  const plaintext = randomBytes(32).toString("base64url")
  return { plaintext, ciphertext: encryptSecret(plaintext) }
}

export function practiceToolUrl(apiBase: string, callId: string): string {
  const base = new URL(apiBase)
  base.pathname = `/v1/practice/calls/${encodeURIComponent(callId)}/tools`
  base.search = ""
  base.hash = ""
  return base.toString()
}

type InvocationBody = {
  tool: string
  arguments: Record<string, unknown>
  callId: string
  assistantId: string
  invocationId: string
}

function parseInvocationBody(rawBody: Uint8Array): InvocationBody | null {
  let value: unknown
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(rawBody)
    )
  } catch {
    return null
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null
  }
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).length !== 5 ||
    typeof record.tool !== "string" ||
    record.arguments === null ||
    typeof record.arguments !== "object" ||
    Array.isArray(record.arguments) ||
    typeof record.callId !== "string" ||
    typeof record.assistantId !== "string" ||
    typeof record.invocationId !== "string" ||
    record.invocationId.length === 0 ||
    record.invocationId.length > 128
  ) {
    return null
  }
  return record as InvocationBody
}

function signatureTimestampAndDigest(
  value: string | null
): { timestamp: number; digest: string } | null {
  if (value === null) return null
  const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(value)
  if (match === null) return null
  const timestamp = Number(match[1])
  return Number.isSafeInteger(timestamp)
    ? { timestamp, digest: match[2]! }
    : null
}

function safeHexEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex")
  const b = Buffer.from(right, "hex")
  return a.length === b.length && timingSafeEqual(a, b)
}

function isFrozenSnapshot(value: unknown): value is FrozenPracticeSnapshot {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Array.isArray((value as FrozenPracticeSnapshot).tools) &&
    Array.isArray((value as FrozenPracticeSnapshot).samples) &&
    typeof (value as FrozenPracticeSnapshot).assistantId === "string"
  )
}

export type PracticeInvocationHeaders = {
  signature: string | null
  callId: string | null
  assistantId: string | null
  invocationId: string | null
}

export type PracticeInvocationResult =
  | { kind: "ok"; status: number; body: JsonValue; readyAt: Date }
  | {
      kind:
        | "invalid_signature"
        | "invalid_request"
        | "not_found"
        | "not_active"
        | "conflict"
        | "limit_exceeded"
      detail: string
    }

export async function invokePracticeSample(input: {
  callId: string
  rawBody: Uint8Array
  headers: PracticeInvocationHeaders
  now?: Date
  clock?: () => Date
  sleep?: (milliseconds: number) => Promise<void>
}): Promise<PracticeInvocationResult> {
  const now = input.now ?? input.clock?.() ?? new Date()
  const callRows = await getDb()
    .select({
      id: calls.id,
      source: calls.source,
      testMode: calls.testMode,
      practiceSecretCiphertext: calls.practiceSecretCiphertext,
    })
    .from(calls)
    .where(eq(calls.id, input.callId))
    .limit(1)
  const call = callRows[0]
  if (
    call === undefined ||
    call.source !== "sandbox" ||
    call.testMode !== "practice" ||
    call.practiceSecretCiphertext === null
  ) {
    return { kind: "not_found", detail: "Practice call was not found." }
  }

  const parsedSignature = signatureTimestampAndDigest(input.headers.signature)
  if (
    parsedSignature === null ||
    Math.abs(now.getTime() / 1000 - parsedSignature.timestamp) >
      PRACTICE_SIGNATURE_TOLERANCE_SECONDS
  ) {
    return { kind: "invalid_signature", detail: "Signature is invalid." }
  }
  let secret: string
  try {
    secret = decryptSecret(call.practiceSecretCiphertext)
  } catch {
    return { kind: "invalid_signature", detail: "Signature is invalid." }
  }
  const expected = createHmac("sha256", secret)
    .update(`${parsedSignature.timestamp}.`)
    .update(input.rawBody)
    .digest("hex")
  if (!safeHexEqual(parsedSignature.digest, expected)) {
    return { kind: "invalid_signature", detail: "Signature is invalid." }
  }

  const body = parseInvocationBody(input.rawBody)
  if (
    body === null ||
    body.callId !== input.callId ||
    input.headers.callId !== body.callId ||
    input.headers.assistantId !== body.assistantId ||
    input.headers.invocationId !== body.invocationId
  ) {
    return {
      kind: "invalid_request",
      detail: "Webhook identity or body is invalid.",
    }
  }

  const requestDigest = createHash("sha256").update(input.rawBody).digest("hex")
  const executionClock = () => input.clock?.() ?? input.now ?? new Date()
  const selected = await getDb().transaction(async (tx) => {
    const execution = await lockPracticeExecution(
      tx,
      input.callId,
      executionClock
    )
    if (execution === null) return { kind: "not_found" } as const
    if (!execution.allowed) return { kind: "not_active" } as const
    const locked = execution.call
    if (
      locked.assistantId !== body.assistantId ||
      !isFrozenSnapshot(locked.practiceSnapshot) ||
      locked.practiceSnapshot.assistantId !== body.assistantId
    ) {
      return { kind: "invalid_request" } as const
    }

    const existingRows = await tx
      .select()
      .from(practiceInvocations)
      .where(
        and(
          eq(practiceInvocations.callId, input.callId),
          eq(practiceInvocations.invocationId, body.invocationId)
        )
      )
      .limit(1)
    const existing = existingRows[0]
    if (existing !== undefined) {
      if (existing.requestDigest !== requestDigest) {
        return { kind: "conflict" } as const
      }
      return {
        kind: "selected",
        status: existing.statusCode,
        body: existing.responseBody as JsonValue,
        readyAt: existing.readyAt,
      } as const
    }

    const [aggregate] = await tx
      .select({ value: count() })
      .from(practiceInvocations)
      .where(eq(practiceInvocations.callId, input.callId))
    if ((aggregate?.value ?? 0) >= MAX_PRACTICE_INVOCATIONS) {
      return { kind: "limit_exceeded" } as const
    }

    const snapshot = locked.practiceSnapshot
    const tool = snapshot.tools.find(
      (candidate) => candidate.name === body.tool
    )
    const sample = snapshot.samples.find(
      (candidate) => candidate.toolName === body.tool
    )
    if (
      tool === undefined ||
      sample === undefined ||
      sample.inputSchemaFingerprint !== fingerprintToolInputSchema(tool) ||
      !validatePracticeArguments(tool, body.arguments)
    ) {
      return { kind: "invalid_request" } as const
    }

    const overrideName = snapshot.scenario.overrides[body.tool]
    const override = sample.overrides.find(
      (candidate) => candidate.name === overrideName
    )
    const result = override?.result ?? sample.defaultResult
    const status = snapshot.scenario.transport === "failure" ? 503 : 200
    const responseBody: JsonValue =
      status === 503
        ? {
            error: {
              code: "practice_transport_failure",
              message: "The synthetic Practice service is unavailable.",
            },
          }
        : { result }
    const readyAt = new Date(
      now.getTime() +
        (snapshot.scenario.transport === "slow" ? PRACTICE_SLOW_DELAY_MS : 0)
    )

    await tx.insert(practiceInvocations).values({
      callId: input.callId,
      invocationId: body.invocationId,
      requestDigest,
      toolName: body.tool,
      scenario: snapshot.scenario.transport,
      statusCode: status,
      responseBody,
      readyAt,
    })
    return { kind: "selected", status, body: responseBody, readyAt } as const
  })

  if (selected.kind !== "selected") {
    const detail =
      selected.kind === "conflict"
        ? "Invocation ID was reused with different content."
        : selected.kind === "limit_exceeded"
          ? "Practice invocation limit was reached."
          : selected.kind === "not_active"
            ? "Practice call is not accepting tools."
            : selected.kind === "not_found"
              ? "Practice call was not found."
              : "Webhook identity, tool, or arguments are invalid."
    return { kind: selected.kind, detail }
  }

  const delay = Math.max(0, selected.readyAt.getTime() - now.getTime())
  if (delay > 0) {
    await (
      input.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    )(delay)
  }

  const release = await getDb().transaction((tx) =>
    lockPracticeExecution(tx, input.callId, executionClock)
  )
  if (!release?.allowed) {
    return {
      kind: "not_active",
      detail: "Practice call stopped before the sample was released.",
    }
  }

  return {
    kind: "ok",
    status: selected.status,
    body: selected.body,
    readyAt: selected.readyAt,
  }
}
