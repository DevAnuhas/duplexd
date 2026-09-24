import { createHash, createHmac } from "node:crypto"
import { and, asc, eq, gt, inArray, lt } from "drizzle-orm"

import { AGENT_EVENT_TYPES, AGENT_SEQUENCE_LIMIT } from "@/control/constants"
import {
  projectReviewEvents,
  projectWorkspaceCallEvents,
  reviewInvocationIds,
} from "@/data/calls"
import { getDb } from "@/db/client"
import { requireAuthSecret } from "@/db/env"
import {
  calls,
  callEvents,
  sandboxAttempts,
  sandboxEvidence,
  practiceInvocations,
} from "@/db/schema"
import { hashCredential } from "@/lib/credentials"
import { secretsMatch } from "@/lib/crypto"
import { canonicalJson } from "@/practice/configuration"
import {
  advanceSandboxExecution,
  isSandboxCallTerminal,
  lockSandboxAgent,
  lockSandboxExecution,
  ownsSandboxExecution,
  requestSandboxStop,
  sandboxControl,
  type SandboxAgent,
  type SandboxTransaction,
  type LockedSandboxExecution,
} from "./execution"
import {
  SANDBOX_PROTOCOL,
  SANDBOX_LIMITS,
  SANDBOX_END_REASONS,
  SANDBOX_EVIDENCE_LIMITS as LIMITS,
  sandboxEvidenceState,
  type AgentProtocol,
  type SandboxCompletion,
  type SandboxEvent,
  type SandboxEvidenceAck,
  type SandboxEventPage,
} from "./protocol"

type Ledger = typeof sandboxEvidence.$inferSelect
type Failure = {
  kind:
    | "not_found"
    | "expired"
    | "invalid_request"
    | "integrity_conflict"
    | "evidence_limit"
    | "rate_limited"
}
type Result = Failure | { kind: "ok"; ack: SandboxEvidenceAck }
const eventTypes = new Set([...AGENT_EVENT_TYPES, "agent_ready"])
const reasons = new Set<string>(SANDBOX_END_REASONS)
const digest = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex")
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

function boundedNesting(value: unknown): boolean {
  const pending = [{ value, depth: 0 }]
  while (pending.length) {
    const item = pending.pop()!
    if (item.depth > 16) return false
    if (item.value !== null && typeof item.value === "object") {
      for (const child of Object.values(item.value))
        pending.push({ value: child, depth: item.depth + 1 })
    }
  }
  return true
}

export function parseSandboxEvents(
  body: Record<string, unknown>
): SandboxEvent[] | null {
  if (
    Object.keys(body).length !== 1 ||
    !Array.isArray(body.events) ||
    body.events.length > LIMITS.batchEvents ||
    !boundedNesting(body) ||
    Buffer.byteLength(canonicalJson(body)) > LIMITS.batchBytes
  )
    return null
  const events: SandboxEvent[] = []
  const seen = new Set<number>()
  for (const event of body.events) {
    if (
      !object(event) ||
      Object.keys(event).length !== 4 ||
      !Number.isInteger(event.seq) ||
      Number(event.seq) < 1 ||
      Number(event.seq) > LIMITS.callEvents ||
      seen.has(Number(event.seq)) ||
      typeof event.at !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(
        event.at
      ) ||
      !Number.isFinite(Date.parse(event.at)) ||
      typeof event.type !== "string" ||
      !eventTypes.has(event.type) ||
      !object(event.payload) ||
      (event.type === "agent_ready" && Object.keys(event.payload).length !== 0)
    )
      return null
    if (Buffer.byteLength(canonicalJson(event)) > LIMITS.eventBytes) return null
    seen.add(Number(event.seq))
    events.push({
      seq: Number(event.seq),
      at: event.at,
      type: event.type,
      payload: event.payload,
    })
  }
  return events
}

export function parseSandboxCompletion(
  body: Record<string, unknown>
): SandboxCompletion | null {
  if (
    Object.keys(body).length !== 5 ||
    typeof body.endedReason !== "string" ||
    !reasons.has(body.endedReason) ||
    typeof body.durationSecs !== "number" ||
    !Number.isFinite(body.durationSecs) ||
    body.durationSecs < 0 ||
    body.durationSecs > 999_999_999.999 ||
    !Number.isInteger(body.finalSeq) ||
    Number(body.finalSeq) < 0 ||
    Number(body.finalSeq) > LIMITS.callEvents ||
    typeof body.producerLoss !== "boolean" ||
    typeof body.truncated !== "boolean"
  )
    return null
  return body as SandboxCompletion
}

async function ledger(tx: SandboxTransaction, callId: string): Promise<Ledger> {
  await tx.insert(sandboxEvidence).values({ callId }).onConflictDoNothing()
  const [value] = await tx
    .select()
    .from(sandboxEvidence)
    .where(eq(sandboxEvidence.callId, callId))
  return value!
}
const state = sandboxEvidenceState
async function acknowledge(
  tx: SandboxTransaction,
  row: LockedSandboxExecution,
  value: Ledger,
  now: Date
): Promise<SandboxEvidenceAck> {
  const seqs = (
    await tx
      .select({ seq: callEvents.seq })
      .from(callEvents)
      .where(eq(callEvents.callId, row.call.id))
      .orderBy(asc(callEvents.seq))
  )
    .map((e) => e.seq)
    .filter((seq) => seq < AGENT_SEQUENCE_LIMIT)
  const present = new Set(seqs)
  let contiguous = 0
  while (present.has(contiguous + 1)) contiguous++
  const missing: [number, number][] = []
  const end = value.finalSeq ?? seqs.at(-1) ?? 0
  for (
    let seq = contiguous + 1;
    seq <= end && missing.length < LIMITS.missingRanges;
    seq++
  ) {
    if (present.has(seq)) continue
    const start = seq
    while (seq < end && !present.has(seq + 1)) seq++
    missing.push([start, seq])
  }
  if (
    value.finalSeq !== null &&
    value.contiguousSeq < value.finalSeq &&
    contiguous === value.finalSeq
  )
    value.reconciled = true
  value.contiguousSeq = contiguous
  await tx
    .update(sandboxEvidence)
    .set(value)
    .where(eq(sandboxEvidence.callId, value.callId))
  return {
    protocol: SANDBOX_PROTOCOL,
    contiguousSeq: contiguous,
    missingRanges: missing,
    evidenceState: state(value),
    completionDigest: value.completionDigest,
    control: sandboxControl(row, now),
  }
}

/** All evidence and completion decisions share the lifecycle's attempt+call lock. */
export function createSandboxEvidence(clock: () => Date = () => new Date()) {
  async function withOwner(
    input: SandboxAgent,
    operation: (
      tx: SandboxTransaction,
      row: LockedSandboxExecution,
      value: Ledger,
      now: Date
    ) => Promise<Result>
  ): Promise<Result> {
    return getDb().transaction(async (tx) => {
      const row = await lockSandboxAgent(tx, input)
      if (!row || !ownsSandboxExecution(row, input.owner))
        return { kind: "not_found" }
      const now = clock()
      await advanceSandboxExecution(tx, row, now)
      if (
        !row.call.configClaimedAt ||
        (isSandboxCallTerminal(row.call) &&
          (!row.attempt.reportingUntil || row.attempt.reportingUntil <= now))
      )
        return { kind: "expired" }
      return operation(tx, row, await ledger(tx, row.call.id), now)
    })
  }
  async function invalid(input: SandboxAgent): Promise<Result> {
    return withOwner(input, async (tx, _row, value, now) => {
      if (
        !value.invalidWindowAt ||
        now.getTime() - value.invalidWindowAt.getTime() >= 60000
      ) {
        value.invalidWindowAt = now
        value.invalidCount = 0
      }
      value.invalidCount = Math.min(value.invalidCount + 1, 11)
      await tx
        .update(sandboxEvidence)
        .set(value)
        .where(eq(sandboxEvidence.callId, value.callId))
      return {
        kind: value.invalidCount > 10 ? "rate_limited" : "invalid_request",
      }
    })
  }
  async function ingest(
    input: SandboxAgent,
    events: SandboxEvent[]
  ): Promise<Result> {
    if (parseSandboxEvents({ events }) === null) return invalid(input)
    return withOwner(input, async (tx, row, value, now) => {
      if (!events.length) {
        if (
          value.lastEmptyAt &&
          now.getTime() - value.lastEmptyAt.getTime() < 3000
        )
          return { kind: "rate_limited" }
        value.lastEmptyAt = now
      }
      const stored = await tx
        .select()
        .from(callEvents)
        .where(eq(callEvents.callId, row.call.id))
      const bySeq = new Map(stored.map((e) => [e.seq, e]))
      const fresh = events.filter((e) => !bySeq.has(e.seq))
      const conflict = events.some(
        (e) =>
          (bySeq.has(e.seq) && bySeq.get(e.seq)!.contentDigest !== digest(e)) ||
          (value.finalSeq !== null && e.seq > value.finalSeq)
      )
      if (conflict) {
        await tx
          .update(sandboxEvidence)
          .set({ integrityConflict: true })
          .where(eq(sandboxEvidence.callId, value.callId))
        await requestSandboxStop(tx, row, "evidence_limit", now)
        return { kind: "integrity_conflict" }
      }
      const bytes = fresh.reduce(
        (total, e) => total + Buffer.byteLength(canonicalJson(e)),
        0
      )
      if (
        value.totalEvents + fresh.length > LIMITS.callEvents ||
        value.totalBytes + bytes > LIMITS.callBytes
      ) {
        await tx
          .update(sandboxEvidence)
          .set({ producerLoss: true })
          .where(eq(sandboxEvidence.callId, value.callId))
        await requestSandboxStop(tx, row, "evidence_limit", now)
        return { kind: "evidence_limit" }
      }
      for (const event of fresh) {
        await tx.insert(callEvents).values({
          callId: value.callId,
          ...event,
          at: new Date(event.at),
          ingestCursor: ++value.lastCursor,
          contentDigest: digest(event),
          byteLength: Buffer.byteLength(canonicalJson(event)),
        })
        // Historical readiness is evidence only. It cannot revive stopped execution.
        if (
          event.type === "agent_ready" &&
          !row.attempt.readyAt &&
          !row.attempt.stopRequestedAt &&
          !isSandboxCallTerminal(row.call)
        ) {
          await tx
            .update(sandboxAttempts)
            .set({ readyAt: now, state: "active" })
            .where(eq(sandboxAttempts.id, row.attempt.id))
          row.attempt.readyAt = now
        }
      }
      value.totalEvents += fresh.length
      value.totalBytes += bytes
      return { kind: "ok", ack: await acknowledge(tx, row, value, now) }
    })
  }
  async function complete(
    input: SandboxAgent,
    completion: SandboxCompletion
  ): Promise<Result> {
    if (!parseSandboxCompletion(completion)) return invalid(input)
    return withOwner(input, async (tx, row, value, now) => {
      const hash = digest(completion)
      const [highest] = await tx
        .select({ seq: callEvents.seq })
        .from(callEvents)
        .where(
          and(
            eq(callEvents.callId, value.callId),
            gt(callEvents.seq, completion.finalSeq),
            lt(callEvents.seq, AGENT_SEQUENCE_LIMIT)
          )
        )
        .limit(1)
      if (
        (value.completionDigest && value.completionDigest !== hash) ||
        (highest && highest.seq < AGENT_SEQUENCE_LIMIT)
      ) {
        await tx
          .update(sandboxEvidence)
          .set({ integrityConflict: true })
          .where(eq(sandboxEvidence.callId, value.callId))
        await requestSandboxStop(tx, row, "evidence_limit", now)
        return { kind: "integrity_conflict" }
      }
      if (!value.completionDigest) {
        const wasIncomplete = row.call.state === "incomplete"
        value.completionDigest = hash
        value.finalSeq = completion.finalSeq
        value.producerLoss ||= completion.producerLoss
        value.truncated ||= completion.truncated
        value.reconciled ||= wasIncomplete
        const reportingUntil =
          row.attempt.reportingUntil ??
          new Date(
            Math.min(
              now.getTime() + SANDBOX_LIMITS.reportingGraceMs,
              row.attempt.stopRequestedAt
                ? row.attempt.stopRequestedAt.getTime() +
                    SANDBOX_LIMITS.gracefulStopMs +
                    SANDBOX_LIMITS.reportingGraceMs
                : Infinity
            )
          )
        // Completion is an observed call ending, not private resource proof.
        // Persist cleanup intent so every retained session still reconciles.
        await requestSandboxStop(tx, row, completion.endedReason, now)
        await tx
          .update(calls)
          .set({
            state: "ended",
            endedReason: completion.endedReason,
            durationSecs: Number(completion.durationSecs.toFixed(3)),
            endedAt: now,
          })
          .where(eq(calls.id, value.callId))
        await tx
          .update(sandboxAttempts)
          .set({ reportingUntil, joinCiphertext: null })
          .where(eq(sandboxAttempts.id, row.attempt.id))
        row.call.state = "ended"
        row.attempt.reportingUntil = reportingUntil
        if (wasIncomplete) {
          await tx.insert(callEvents).values({
            callId: value.callId,
            seq: AGENT_SEQUENCE_LIMIT + 1,
            type: "completion_reconciled",
            at: now,
            payload: {},
            ingestCursor: ++value.lastCursor,
          })
        }
      }
      return { kind: "ok", ack: await acknowledge(tx, row, value, now) }
    })
  }
  return { ingest, complete, invalid }
}
export const sandboxEvidenceService = createSandboxEvidence()

export async function negotiateAgentProtocol(
  callId: string,
  token: string
): Promise<AgentProtocol | null> {
  const [call] = await getDb().select().from(calls).where(eq(calls.id, callId))
  if (
    !call?.agentTokenHash ||
    !secretsMatch(call.agentTokenHash, hashCredential(token)) ||
    isSandboxCallTerminal(call)
  )
    return null
  return call.source === "sandbox" ? SANDBOX_PROTOCOL : "integration-v1"
}

function cursor(accountId: string, callId: string, n: number): string {
  const value = `v1.${n}`
  return `${value}.${createHmac("sha256", requireAuthSecret())
    .update(JSON.stringify(["sandbox-events", accountId, callId, value]))
    .digest("base64url")}`
}

export async function getSandboxEventPage(
  accountId: string,
  callId: string,
  after: string | null
): Promise<SandboxEventPage | null | "invalid_cursor"> {
  return getDb().transaction(async (tx) => {
    const [identity] = await tx
      .select({ id: sandboxAttempts.id })
      .from(sandboxAttempts)
      .where(
        and(
          eq(sandboxAttempts.callId, callId),
          eq(sandboxAttempts.accountId, accountId)
        )
      )
    if (!identity) return null
    const row = await lockSandboxExecution(tx, identity.id)
    if (!row || row.call.accountId !== accountId) return null
    await advanceSandboxExecution(tx, row, new Date())
    let offset = 0
    if (after !== null) {
      if (!/^v1\.(0|[1-9]\d{0,8})\.[A-Za-z0-9_-]{43}$/.test(after))
        return "invalid_cursor"
      offset = Number(after.split(".")[1])
      if (!secretsMatch(after, cursor(accountId, callId, offset)))
        return "invalid_cursor"
    }
    const value = await ledger(tx, callId)
    const rows = await tx
      .select()
      .from(callEvents)
      .where(
        and(eq(callEvents.callId, callId), gt(callEvents.ingestCursor, offset))
      )
      .orderBy(asc(callEvents.ingestCursor))
      .limit(LIMITS.pageEvents + 1)
    const pageRows = rows.slice(0, LIMITS.pageEvents)
    const projected = projectWorkspaceCallEvents(pageRows)
    const invocationIds = reviewInvocationIds(projected)
    const selections =
      invocationIds.length === 0
        ? []
        : await tx
            .select({
              invocationId: practiceInvocations.invocationId,
              scenario: practiceInvocations.scenario,
              statusCode: practiceInvocations.statusCode,
            })
            .from(practiceInvocations)
            .where(
              and(
                eq(practiceInvocations.callId, callId),
                inArray(practiceInvocations.invocationId, invocationIds)
              )
            )
    const reviewEvents = projectReviewEvents(projected, selections)
    const events: SandboxEventPage["events"] = []
    let bytes = 0
    for (const [index, event] of pageRows.entries()) {
      const item: SandboxEventPage["events"][number] = {
        ...reviewEvents[index]!,
        cursor: cursor(accountId, callId, event.ingestCursor!),
      }
      const size = Buffer.byteLength(JSON.stringify(item))
      if (bytes + size > LIMITS.pageBytes - 1024) break
      bytes += size
      events.push(item)
    }
    return {
      events,
      nextCursor: events.at(-1)?.cursor ?? after,
      hasMore: rows.length > events.length,
      evidence: {
        state: state(value),
        contiguousSeq: value.contiguousSeq,
        finalSeq: value.finalSeq,
        producerLoss: value.producerLoss,
        truncated: value.truncated,
        integrityConflict: value.integrityConflict,
        reconciled: value.reconciled,
      },
    }
  })
}
