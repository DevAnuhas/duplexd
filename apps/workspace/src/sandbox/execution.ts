import { eq } from "drizzle-orm"

import { getDb } from "@/db/client"
import { calls, sandboxAttempts } from "@/db/schema"

import { SANDBOX_LIMITS as LIMITS } from "./protocol"

type Db = ReturnType<typeof getDb>
export type SandboxTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0]
type Attempt = typeof sandboxAttempts.$inferSelect
type Call = typeof calls.$inferSelect
export type LockedSandboxExecution = { attempt: Attempt; call: Call }
export async function lockSandboxExecution(
  tx: SandboxTransaction,
  attemptId: string
): Promise<LockedSandboxExecution | null> {
  const [row] = await tx
    .select({ attempt: sandboxAttempts, call: calls })
    .from(sandboxAttempts)
    .innerJoin(calls, eq(calls.id, sandboxAttempts.callId))
    .where(eq(sandboxAttempts.id, attemptId))
    .for("update")
  return row ?? null
}

export function isSandboxCallTerminal(call: Call): boolean {
  return ["ended", "incomplete", "failed"].includes(call.state)
}

export async function requestSandboxStop(
  tx: SandboxTransaction,
  row: LockedSandboxExecution,
  reason: string,
  now: Date
): Promise<void> {
  if (row.attempt.stopRequestedAt) return
  await tx
    .update(sandboxAttempts)
    .set({
      stopRequestedAt: now,
      stopReason: reason,
      state: "stopping",
      joinCiphertext: null,
      resourceState: "stop_requested",
    })
    .where(eq(sandboxAttempts.id, row.attempt.id))
  await tx
    .update(calls)
    .set({ stopRequestedAt: now })
    .where(eq(calls.id, row.call.id))
  row.attempt.stopRequestedAt = now
  row.attempt.stopReason = reason
  row.attempt.state = "stopping"
  row.attempt.resourceState = "stop_requested"
  row.attempt.joinCiphertext = null
  row.call.stopRequestedAt = now
}

/** Durable deadlines, evaluated on requests/sweep, never extended by control. */
export async function advanceSandboxExecution(
  tx: SandboxTransaction,
  row: LockedSandboxExecution,
  now: Date
): Promise<void> {
  const a = row.attempt
  if (!a.dispatchedAt) return
  if (
    !a.dispatchSettledAt &&
    now.getTime() >= a.dispatchedAt.getTime() + LIMITS.dispatchMs
  ) {
    await tx
      .update(sandboxAttempts)
      .set({ dispatchSettledAt: now })
      .where(eq(sandboxAttempts.id, a.id))
    a.dispatchSettledAt = now
    await requestSandboxStop(
      tx,
      row,
      "start_unknown",
      new Date(a.dispatchedAt.getTime() + LIMITS.dispatchMs)
    )
  }
  if (!a.stopRequestedAt && !isSandboxCallTerminal(row.call)) {
    const deadlines: Array<{ reason: string; at: Date }> = []
    if (row.call.executionDeadline)
      deadlines.push({
        reason: "execution_deadline",
        at: row.call.executionDeadline,
      })
    if (a.presenceExpiresAt)
      deadlines.push({ reason: "presence_expired", at: a.presenceExpiresAt })
    if (row.call.configClaimedAt && row.call.lastHeartbeatAt)
      deadlines.push({
        reason: "control_lost",
        at: new Date(
          row.call.lastHeartbeatAt.getTime() + LIMITS.controlLossTimeoutMs
        ),
      })
    if (!a.readyAt && a.startupDeadline)
      deadlines.push({ reason: "startup_deadline", at: a.startupDeadline })
    const due = deadlines.sort(
      (left, right) => left.at.getTime() - right.at.getTime()
    )[0]
    if (due && due.at <= now)
      await requestSandboxStop(tx, row, due.reason, due.at)
  }
  if (
    a.stopRequestedAt &&
    !isSandboxCallTerminal(row.call) &&
    now.getTime() >= a.stopRequestedAt.getTime() + LIMITS.gracefulStopMs
  ) {
    const state = row.call.configClaimedAt ? "incomplete" : "failed"
    const reportingUntil = new Date(
      a.stopRequestedAt.getTime() +
        LIMITS.gracefulStopMs +
        LIMITS.reportingGraceMs
    )
    await tx
      .update(calls)
      .set({ state, endedReason: a.stopReason, endedAt: now })
      .where(eq(calls.id, row.call.id))
    await tx
      .update(sandboxAttempts)
      .set({ reportingUntil })
      .where(eq(sandboxAttempts.id, a.id))
    row.call.state = state
    a.reportingUntil = reportingUntil
  }
}

/**
 * A signed Practice request may be the first observer of an expired lease.
 * Take the same attempt+call locks as lifecycle operations before advancing;
 * never acquire the call lock first and then wait for the attempt lock.
 * Older standalone Practice snapshots have no attempt and retain their
 * existing call-level expiry contract. This function performs no provider I/O.
 */
export async function lockPracticeExecution(
  tx: SandboxTransaction,
  callId: string,
  clock: () => Date
): Promise<{ call: Call; allowed: boolean } | null> {
  const [identity] = await tx
    .select({ id: sandboxAttempts.id })
    .from(sandboxAttempts)
    .where(eq(sandboxAttempts.callId, callId))
  let call: Call
  let now: Date
  if (identity) {
    const row = await lockSandboxExecution(tx, identity.id)
    if (!row) return null
    now = clock()
    await advanceSandboxExecution(tx, row, now)
    call = row.call
  } else {
    const [row] = await tx
      .select()
      .from(calls)
      .where(eq(calls.id, callId))
      .for("update")
    if (!row) return null
    now = clock()
    call = row
  }
  return {
    call,
    allowed:
      call.source === "sandbox" &&
      call.testMode === "practice" &&
      call.state === "active" &&
      call.stopRequestedAt === null &&
      call.executionDeadline !== null &&
      call.executionDeadline > now,
  }
}
