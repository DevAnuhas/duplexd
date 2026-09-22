import { createHash, randomUUID } from "node:crypto"

import { and, count, eq, inArray, isNull, lt, lte, sql } from "drizzle-orm"

import { getDb } from "@/db/client"
import { sandboxExecutionConfigured } from "@/db/env"
import {
  accounts,
  assistantSamples,
  assistants,
  calls,
  sandboxAdmissionRateLimits,
  sandboxAttempts,
  sandboxSlots,
} from "@/db/schema"
import { secretsMatch } from "@/lib/crypto"
import {
  compilePracticeConfiguration,
  sha256Digest,
  type PracticeScenario,
} from "@/practice/configuration"
import { parsePracticeSampleDefinitions } from "@/practice/samples"

export const SANDBOX_EXECUTION_DISABLED_CODE =
  "sandbox_execution_disabled" as const
export const SANDBOX_CONTROLLER_HEADER = "x-duplexd-controller-proof"
export const SANDBOX_PREPARE_BODY_LIMIT = 256 * 1024
export const SANDBOX_RESERVATION_MS = 30_000
export const SANDBOX_RATE_WINDOW_MS = 60_000
export const SANDBOX_USER_ADMISSIONS_PER_WINDOW = 5
export const SANDBOX_ACCOUNT_ADMISSIONS_PER_WINDOW = 20
export const SANDBOX_ACCOUNT_UNRESOLVED_LIMIT = 5
export const SANDBOX_SNAPSHOT_VERSION = 1

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const CONTROLLER_PROOF_PATTERN = /^[A-Za-z0-9_-]{43}$/

export type SandboxPrepareInput = {
  clientAttemptId: string
  assistantId: string
  baseRevision: number
  source: "saved" | "preview"
  preview?: Record<string, unknown>
  samples?: unknown
  sampleRevision?: number
  scenario?: Partial<PracticeScenario>
  scenarioRevision?: number
}

export type SandboxAttemptDto = {
  attemptId: string
  callId: string
  assistantId: string | null
  state: string
  callState: string
  source: "sandbox"
  testMode: "practice"
  configSource: string | null
  baseAssistantRevision: number | null
  preparedAt: string
  reservationExpiresAt: string
  canceledAt: string | null
  expiredAt: string | null
  stopRequestedAt: string | null
  execution: "disabled" | "enabled"
  resourceState: string
  startupDeadline: string | null
  executionDeadline: string | null
  presenceExpiresAt: string | null
  serverTime: string
  readyAt: string | null
}

export type PrepareSandboxAttemptResult =
  | { kind: "created" | "replay"; attempt: SandboxAttemptDto }
  | { kind: "attempt_conflict" }
  | { kind: "assistant_not_found" }
  | { kind: "assistant_changed"; currentRevision: number }
  | { kind: "samples_changed"; currentRevision: number }
  | { kind: "invalid"; issues: Array<{ field: string; message: string }> }
  | { kind: "user_slot_occupied"; attempt: SandboxAttemptDto }
  | { kind: "account_capacity_exceeded" }
  | { kind: "user_rate_exceeded" | "account_rate_exceeded" }

export type SandboxBoundaryResult =
  | { kind: "not_found" }
  | { kind: "not_owner" }
  | { kind: "invalid_controller" }
  | { kind: "disabled"; attempt: SandboxAttemptDto }

export type CancelSandboxAttemptResult =
  | { kind: "not_found" }
  | { kind: "not_owner" }
  | { kind: "canceled" | "unchanged"; attempt: SandboxAttemptDto }
  | { kind: "provider_cleanup_disabled"; attempt: SandboxAttemptDto }

type AttemptProjection = {
  readyAt: Date | null
  resourceState: string
  startupDeadline: Date | null
  executionDeadline: Date | null
  presenceExpiresAt: Date | null
  attemptId: string
  callId: string
  assistantId: string | null
  initiatedByUserId: string | null
  controllerProofHash: string
  state: string
  preparedAt: Date
  reservationExpiresAt: Date
  canceledAt: Date | null
  expiredAt: Date | null
  attemptStopRequestedAt: Date | null
  callState: string
  source: string
  testMode: string | null
  configSource: string | null
  baseAssistantRevision: number | null
}

type WorkspaceDb = ReturnType<typeof getDb>
type WorkspaceTx = Parameters<Parameters<WorkspaceDb["transaction"]>[0]>[0]

// Keep the scope in the error's type, not an own property. The database
// redaction proxy intentionally blanks unknown error properties; a `scope`
// field would become "[redacted]" while the transaction rollback crosses that
// boundary and could mislabel a user limit as an account limit.
class UserAdmissionLimitError extends Error {}
class AccountAdmissionLimitError extends Error {}

const attemptColumns = {
  readyAt: sandboxAttempts.readyAt,
  resourceState: sandboxAttempts.resourceState,
  startupDeadline: sandboxAttempts.startupDeadline,
  executionDeadline: calls.executionDeadline,
  presenceExpiresAt: sandboxAttempts.presenceExpiresAt,
  attemptId: sandboxAttempts.id,
  callId: sandboxAttempts.callId,
  assistantId: calls.assistantId,
  initiatedByUserId: sandboxAttempts.initiatedByUserId,
  controllerProofHash: sandboxAttempts.controllerProofHash,
  state: sandboxAttempts.state,
  preparedAt: sandboxAttempts.preparedAt,
  reservationExpiresAt: sandboxAttempts.reservationExpiresAt,
  canceledAt: sandboxAttempts.canceledAt,
  expiredAt: sandboxAttempts.expiredAt,
  attemptStopRequestedAt: sandboxAttempts.stopRequestedAt,
  callState: calls.state,
  source: calls.source,
  testMode: calls.testMode,
  configSource: calls.configSource,
  baseAssistantRevision: calls.baseAssistantRevision,
} as const

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function scenarioIsValid(value: unknown): value is Partial<PracticeScenario> {
  if (value === undefined) return true
  if (!isPlainObject(value)) return false
  if (
    Object.keys(value).some((key) => !["transport", "overrides"].includes(key))
  ) {
    return false
  }
  if (
    value.transport !== undefined &&
    value.transport !== "success" &&
    value.transport !== "slow" &&
    value.transport !== "failure"
  ) {
    return false
  }
  return (
    value.overrides === undefined ||
    (isPlainObject(value.overrides) &&
      Object.values(value.overrides).every(
        (override) => typeof override === "string"
      ))
  )
}

export function parseSandboxPrepareInput(
  value: unknown
): { ok: true; input: SandboxPrepareInput } | { ok: false } {
  if (!isPlainObject(value)) return { ok: false }
  const allowed = new Set([
    "clientAttemptId",
    "assistantId",
    "baseRevision",
    "source",
    "preview",
    "samples",
    "sampleRevision",
    "scenario",
    "scenarioRevision",
  ])
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    return { ok: false }
  }
  if (
    typeof value.clientAttemptId !== "string" ||
    !UUID_PATTERN.test(value.clientAttemptId) ||
    typeof value.assistantId !== "string" ||
    value.assistantId.trim() === "" ||
    !isNonNegativeInteger(value.baseRevision) ||
    (value.source !== "saved" && value.source !== "preview") ||
    (value.preview !== undefined && !isPlainObject(value.preview)) ||
    (value.source === "saved" && value.preview !== undefined) ||
    (value.sampleRevision !== undefined &&
      !isNonNegativeInteger(value.sampleRevision)) ||
    (value.samples !== undefined && value.sampleRevision === undefined) ||
    (value.scenarioRevision !== undefined &&
      !isNonNegativeInteger(value.scenarioRevision)) ||
    !scenarioIsValid(value.scenario)
  ) {
    return { ok: false }
  }

  return {
    ok: true,
    input: {
      clientAttemptId: value.clientAttemptId.toLowerCase(),
      assistantId: value.assistantId,
      baseRevision: value.baseRevision,
      source: value.source,
      ...(value.preview === undefined ? {} : { preview: value.preview }),
      ...(value.samples === undefined ? {} : { samples: value.samples }),
      ...(value.sampleRevision === undefined
        ? {}
        : { sampleRevision: value.sampleRevision }),
      ...(value.scenario === undefined
        ? {}
        : { scenario: value.scenario as Partial<PracticeScenario> }),
      ...(value.scenarioRevision === undefined
        ? {}
        : { scenarioRevision: value.scenarioRevision }),
    },
  }
}

export function hashSandboxControllerProof(value: string): string | null {
  if (!CONTROLLER_PROOF_PATTERN.test(value)) return null
  const decoded = Buffer.from(value, "base64url")
  if (decoded.length !== 32 || decoded.toString("base64url") !== value) {
    return null
  }
  return createHash("sha256").update(decoded).digest("hex")
}

function projectAttempt(
  row: AttemptProjection,
  now = new Date()
): SandboxAttemptDto {
  return {
    serverTime: now.toISOString(),
    readyAt: row.readyAt?.toISOString() ?? null,
    attemptId: row.attemptId,
    callId: row.callId,
    assistantId: row.assistantId,
    state: row.state,
    callState: row.callState,
    source: "sandbox",
    testMode: "practice",
    configSource: row.configSource,
    baseAssistantRevision: row.baseAssistantRevision,
    preparedAt: row.preparedAt.toISOString(),
    reservationExpiresAt: row.reservationExpiresAt.toISOString(),
    canceledAt: row.canceledAt?.toISOString() ?? null,
    expiredAt: row.expiredAt?.toISOString() ?? null,
    stopRequestedAt: row.attemptStopRequestedAt?.toISOString() ?? null,
    // The browser offers Start on "enabled" alone, so this must report what
    // the routes will actually do rather than a constant. Both read the one
    // predicate in `db/env.ts`; see ADR 015.
    execution: sandboxExecutionConfigured() ? "enabled" : "disabled",
    resourceState: row.resourceState,
    startupDeadline: row.startupDeadline?.toISOString() ?? null,
    executionDeadline: row.executionDeadline?.toISOString() ?? null,
    presenceExpiresAt: row.presenceExpiresAt?.toISOString() ?? null,
  }
}

async function readAttempt(
  db: WorkspaceDb | WorkspaceTx,
  accountId: string,
  attemptId: string
): Promise<AttemptProjection | null> {
  const rows = await db
    .select(attemptColumns)
    .from(sandboxAttempts)
    .innerJoin(calls, eq(calls.id, sandboxAttempts.callId))
    .where(
      and(
        eq(sandboxAttempts.id, attemptId),
        eq(sandboxAttempts.accountId, accountId),
        eq(calls.accountId, accountId)
      )
    )
    .limit(1)
  return rows[0] ?? null
}

async function expirePreparedAttempts(
  tx: WorkspaceTx,
  now: Date,
  accountId?: string
): Promise<number> {
  const expired = await tx
    .update(sandboxAttempts)
    .set({ state: "expired", expiredAt: now })
    .where(
      and(
        eq(sandboxAttempts.state, "prepared"),
        lte(sandboxAttempts.reservationExpiresAt, now),
        ...(accountId === undefined
          ? []
          : [eq(sandboxAttempts.accountId, accountId)])
      )
    )
    .returning({ id: sandboxAttempts.id, callId: sandboxAttempts.callId })

  if (expired.length === 0) return 0
  const attemptIds = expired.map((row) => row.id)
  const callIds = expired.map((row) => row.callId)
  await tx
    .delete(sandboxSlots)
    .where(inArray(sandboxSlots.attemptId, attemptIds))
  await tx
    .update(calls)
    .set({ state: "failed", endedReason: "reservation_expired", endedAt: now })
    .where(and(inArray(calls.id, callIds), eq(calls.state, "reserved")))
  return expired.length
}

async function consumeAdmissionCounter(
  tx: WorkspaceTx,
  input: {
    accountId: string
    subjectType: "user" | "account"
    subjectId: string
    windowStartedAt: Date
    limit: number
  }
): Promise<boolean> {
  const rows = await tx
    .insert(sandboxAdmissionRateLimits)
    .values({
      accountId: input.accountId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      windowStartedAt: input.windowStartedAt,
      count: 1,
    })
    .onConflictDoUpdate({
      target: [
        sandboxAdmissionRateLimits.accountId,
        sandboxAdmissionRateLimits.subjectType,
        sandboxAdmissionRateLimits.subjectId,
        sandboxAdmissionRateLimits.windowStartedAt,
      ],
      set: { count: sql`${sandboxAdmissionRateLimits.count} + 1` },
      setWhere: lt(sandboxAdmissionRateLimits.count, input.limit),
    })
    .returning({ count: sandboxAdmissionRateLimits.count })
  return rows.length === 1
}

export async function prepareSandboxAttempt(input: {
  accountId: string
  userId: string
  controllerProofHash: string
  request: SandboxPrepareInput
  now?: Date
}): Promise<PrepareSandboxAttemptResult> {
  const now = input.now ?? new Date()
  const inputDigest = sha256Digest(input.request)
  const windowStartedAt = new Date(
    Math.floor(now.getTime() / SANDBOX_RATE_WINDOW_MS) * SANDBOX_RATE_WINDOW_MS
  )

  try {
    return await getDb().transaction(async (tx) => {
      const lockedAccounts = await tx
        .select({ id: accounts.id })
        .from(accounts)
        .where(eq(accounts.id, input.accountId))
        .limit(1)
        .for("update")
      if (lockedAccounts[0] === undefined)
        return { kind: "assistant_not_found" }

      await expirePreparedAttempts(tx, now, input.accountId)

      const existingRows = await tx
        .select({
          id: sandboxAttempts.id,
          inputDigest: sandboxAttempts.inputDigest,
          controllerProofHash: sandboxAttempts.controllerProofHash,
        })
        .from(sandboxAttempts)
        .where(
          and(
            eq(sandboxAttempts.accountId, input.accountId),
            eq(sandboxAttempts.initiatedByUserId, input.userId),
            eq(sandboxAttempts.clientAttemptId, input.request.clientAttemptId)
          )
        )
        .limit(1)
      const existing = existingRows[0]
      if (existing !== undefined) {
        if (
          !secretsMatch(existing.inputDigest, inputDigest) ||
          !secretsMatch(existing.controllerProofHash, input.controllerProofHash)
        ) {
          return { kind: "attempt_conflict" } as const
        }
        const row = await readAttempt(tx, input.accountId, existing.id)
        if (row === null) throw new Error("Sandbox attempt lost its call row.")
        return { kind: "replay", attempt: projectAttempt(row, now) } as const
      }

      const assistantRows = await tx
        .select({
          id: assistants.id,
          revision: assistants.revision,
          voice: assistants.voice,
          accentStyle: assistants.accentStyle,
          instructions: assistants.instructions,
          backendInstructions: assistants.backendInstructions,
          backendModel: assistants.backendModel,
          waitingBehavior: assistants.waitingBehavior,
          tools: assistants.tools,
        })
        .from(assistants)
        .where(
          and(
            eq(assistants.id, input.request.assistantId),
            eq(assistants.accountId, input.accountId),
            isNull(assistants.archivedAt)
          )
        )
        .limit(1)
        .for("update")
      const assistant = assistantRows[0]
      if (assistant === undefined)
        return { kind: "assistant_not_found" } as const
      if (assistant.revision !== input.request.baseRevision) {
        return {
          kind: "assistant_changed",
          currentRevision: assistant.revision,
        } as const
      }

      const storedSampleRows = await tx
        .select({
          revision: assistantSamples.revision,
          definitions: assistantSamples.definitions,
        })
        .from(assistantSamples)
        .where(
          and(
            eq(assistantSamples.assistantId, assistant.id),
            eq(assistantSamples.accountId, input.accountId)
          )
        )
        .limit(1)
      const storedSamples = storedSampleRows[0]
      const currentSampleRevision = storedSamples?.revision ?? 0
      if (
        input.request.sampleRevision !== undefined &&
        input.request.sampleRevision !== currentSampleRevision
      ) {
        return {
          kind: "samples_changed",
          currentRevision: currentSampleRevision,
        } as const
      }
      const samplesValue =
        input.request.samples ?? storedSamples?.definitions ?? []
      const effectiveTools =
        input.request.source === "preview" &&
        input.request.preview?.tools !== undefined
          ? input.request.preview.tools
          : assistant.tools
      const parsedSamples = parsePracticeSampleDefinitions(
        samplesValue,
        effectiveTools
      )
      if (!parsedSamples.ok) {
        return { kind: "invalid", issues: parsedSamples.issues } as const
      }

      const compiled = compilePracticeConfiguration({
        assistant,
        baseRevision: input.request.baseRevision,
        source: input.request.source,
        preview: input.request.preview,
        samples: parsedSamples.definitions,
        sampleRevision: input.request.sampleRevision ?? currentSampleRevision,
        scenario: input.request.scenario,
        scenarioRevision: input.request.scenarioRevision,
      })
      if (compiled.kind !== "ready") return compiled

      const occupiedRows = await tx
        .select({ attemptId: sandboxSlots.attemptId })
        .from(sandboxSlots)
        .where(
          and(
            eq(sandboxSlots.accountId, input.accountId),
            eq(sandboxSlots.userId, input.userId)
          )
        )
        .limit(1)
      const occupied = occupiedRows[0]
      if (occupied !== undefined) {
        const row = await readAttempt(tx, input.accountId, occupied.attemptId)
        if (row === null) throw new Error("Sandbox slot lost its attempt row.")
        return {
          kind: "user_slot_occupied",
          attempt: projectAttempt(row, now),
        } as const
      }

      const accountSlots = await tx
        .select({ value: count() })
        .from(sandboxSlots)
        .where(eq(sandboxSlots.accountId, input.accountId))
      if ((accountSlots[0]?.value ?? 0) >= SANDBOX_ACCOUNT_UNRESOLVED_LIMIT) {
        return { kind: "account_capacity_exceeded" } as const
      }

      if (
        !(await consumeAdmissionCounter(tx, {
          accountId: input.accountId,
          subjectType: "user",
          subjectId: input.userId,
          windowStartedAt,
          limit: SANDBOX_USER_ADMISSIONS_PER_WINDOW,
        }))
      ) {
        throw new UserAdmissionLimitError(
          "Sandbox user admission limit exceeded."
        )
      }
      if (
        !(await consumeAdmissionCounter(tx, {
          accountId: input.accountId,
          subjectType: "account",
          subjectId: input.accountId,
          windowStartedAt,
          limit: SANDBOX_ACCOUNT_ADMISSIONS_PER_WINDOW,
        }))
      ) {
        throw new AccountAdmissionLimitError(
          "Sandbox account admission limit exceeded."
        )
      }

      const attemptId = randomUUID()
      const callId = randomUUID()
      const reservationExpiresAt = new Date(
        now.getTime() + SANDBOX_RESERVATION_MS
      )
      await tx.insert(calls).values({
        id: callId,
        accountId: input.accountId,
        assistantId: assistant.id,
        initiatedByUserId: input.userId,
        assistantSnapshot: {
          assistantId: assistant.id,
          snapshotVersion: SANDBOX_SNAPSHOT_VERSION,
        },
        source: "sandbox",
        channel: "browser",
        testMode: "practice",
        configSource: compiled.snapshot.configSource,
        baseAssistantRevision: compiled.snapshot.baseAssistantRevision,
        configDigest: compiled.snapshot.configDigest,
        snapshotVersion: SANDBOX_SNAPSHOT_VERSION,
        scenarioRevision: compiled.snapshot.scenarioRevision,
        practiceCompilerVersion: compiled.snapshot.compilerVersion,
        practiceSnapshot: compiled.snapshot,
        agentTokenHash: null,
        state: "reserved",
        createdAt: now,
      })
      await tx.insert(sandboxAttempts).values({
        id: attemptId,
        accountId: input.accountId,
        initiatedByUserId: input.userId,
        callId,
        clientAttemptId: input.request.clientAttemptId,
        inputDigest,
        controllerProofHash: input.controllerProofHash,
        state: "prepared",
        preparedAt: now,
        reservationExpiresAt,
      })
      await tx.insert(sandboxSlots).values({
        accountId: input.accountId,
        userId: input.userId,
        attemptId,
        acquiredAt: now,
      })

      const row = await readAttempt(tx, input.accountId, attemptId)
      if (row === null) throw new Error("Created Sandbox attempt is missing.")
      return { kind: "created", attempt: projectAttempt(row, now) } as const
    })
  } catch (error) {
    if (error instanceof UserAdmissionLimitError) {
      return { kind: "user_rate_exceeded" }
    }
    if (error instanceof AccountAdmissionLimitError) {
      return { kind: "account_rate_exceeded" }
    }
    throw error
  }
}

export async function expireSandboxReservations(
  now = new Date()
): Promise<number> {
  return getDb().transaction((tx) => expirePreparedAttempts(tx, now))
}

export async function getCurrentSandboxAttempt(input: {
  accountId: string
  userId: string
  now?: Date
}): Promise<SandboxAttemptDto | null> {
  await expireSandboxReservations(input.now)
  const rows = await getDb()
    .select({ attemptId: sandboxSlots.attemptId })
    .from(sandboxSlots)
    .where(
      and(
        eq(sandboxSlots.accountId, input.accountId),
        eq(sandboxSlots.userId, input.userId)
      )
    )
    .limit(1)
  const attemptId = rows[0]?.attemptId
  if (attemptId === undefined) return null
  const row = await readAttempt(getDb(), input.accountId, attemptId)
  return row === null ? null : projectAttempt(row, input.now)
}

export async function getSandboxAttemptForAccount(input: {
  accountId: string
  attemptId: string
  now?: Date
}): Promise<SandboxAttemptDto | null> {
  await expireSandboxReservations(input.now)
  const row = await readAttempt(getDb(), input.accountId, input.attemptId)
  return row === null ? null : projectAttempt(row, input.now)
}

/**
 * Execution-bearing operations all terminate here while A01/A04 are absent.
 * There is intentionally no provider client, token mint, or credential-return
 * callback below this boundary, so a route cannot accidentally "turn on" by
 * changing presentation code.
 */
export async function refuseDisabledSandboxExecution(input: {
  accountId: string
  userId: string
  attemptId: string
  controllerProofHash: string
  now?: Date
}): Promise<SandboxBoundaryResult> {
  await expireSandboxReservations(input.now)
  const row = await readAttempt(getDb(), input.accountId, input.attemptId)
  if (row === null) return { kind: "not_found" }
  if (row.initiatedByUserId !== input.userId) return { kind: "not_owner" }
  if (!secretsMatch(row.controllerProofHash, input.controllerProofHash)) {
    return { kind: "invalid_controller" }
  }
  return { kind: "disabled", attempt: projectAttempt(row, input.now) }
}

export async function cancelSandboxAttempt(input: {
  accountId: string
  userId: string
  attemptId: string
  now?: Date
}): Promise<CancelSandboxAttemptResult> {
  const now = input.now ?? new Date()
  return getDb().transaction(async (tx) => {
    await expirePreparedAttempts(tx, now, input.accountId)
    const rows = await tx
      .select(attemptColumns)
      .from(sandboxAttempts)
      .innerJoin(calls, eq(calls.id, sandboxAttempts.callId))
      .where(
        and(
          eq(sandboxAttempts.id, input.attemptId),
          eq(sandboxAttempts.accountId, input.accountId),
          eq(calls.accountId, input.accountId)
        )
      )
      .limit(1)
      .for("update")
    const row = rows[0]
    if (row === undefined) return { kind: "not_found" } as const
    if (row.initiatedByUserId !== input.userId)
      return { kind: "not_owner" } as const

    if (row.state === "prepared") {
      await tx
        .update(sandboxAttempts)
        .set({
          state: "canceled",
          stopRequestedAt: now,
          stopReason: "user_canceled",
          canceledAt: now,
        })
        .where(
          and(
            eq(sandboxAttempts.id, input.attemptId),
            eq(sandboxAttempts.state, "prepared")
          )
        )
      await tx
        .delete(sandboxSlots)
        .where(eq(sandboxSlots.attemptId, input.attemptId))
      await tx
        .update(calls)
        .set({
          state: "failed",
          stopRequestedAt: now,
          endedReason: "canceled_before_dispatch",
          endedAt: now,
        })
        .where(and(eq(calls.id, row.callId), eq(calls.state, "reserved")))
      const canceled = await readAttempt(tx, input.accountId, input.attemptId)
      if (canceled === null)
        throw new Error("Canceled Sandbox attempt is missing.")
      return {
        kind: "canceled",
        attempt: projectAttempt(canceled, now),
      } as const
    }

    if (row.state === "canceled" || row.state === "expired") {
      return { kind: "unchanged", attempt: projectAttempt(row, now) } as const
    }

    return {
      kind: "provider_cleanup_disabled",
      attempt: projectAttempt(row, now),
    } as const
  })
}
