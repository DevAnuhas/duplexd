import { randomUUID } from "node:crypto"

import { and, eq, lte, ne, sql } from "drizzle-orm"

import {
  DELEGATION_TIMEOUT_SECS,
  FUNCTION_CALL_TIMEOUT_SECS,
  WEBHOOK_TIMEOUT_SECS,
} from "@/control/constants"
import { getDb } from "@/db/client"
import {
  calls,
  sandboxAttempts,
  sandboxSessions,
  sandboxSlots,
} from "@/db/schema"
import { mintAgentToken } from "@/lib/credentials"
import { decryptSecret, encryptSecret, secretsMatch } from "@/lib/crypto"
import type { FrozenPracticeSnapshot } from "@/practice/configuration"
import { createPracticeSecret, practiceToolUrl } from "@/practice/samples"

import {
  cancelSandboxAttempt,
  expireSandboxReservations,
  getCurrentSandboxAttempt,
  getSandboxAttemptForAccount,
  refuseDisabledSandboxExecution,
} from "./admission"
import {
  SANDBOX_LIMITS as LIMITS,
  SANDBOX_PROTOCOL,
  validSandboxIdentity,
  type SandboxBinding,
  type SandboxConfig,
  type SandboxControl,
  type SandboxJoin,
  type SandboxOwner,
  type SandboxTransport,
} from "./protocol"

import {
  advanceSandboxExecution as advance,
  lockSandboxAgent as agentLocked,
  ownsSandboxExecution as owns,
  sandboxControl as control,
  isSandboxCallTerminal as isTerminal,
  lockSandboxExecution as locked,
  requestSandboxStop as stopIntent,
  type LockedSandboxExecution as Locked,
} from "./execution"
type BrowserOwner = {
  accountId: string
  userId: string
  attemptId: string
  controllerProofHash: string
}
type Agent = { callId: string; token: string; owner: SandboxOwner }
type Failure = {
  kind:
    | "not_found"
    | "not_owner"
    | "invalid_controller"
    | "unavailable"
    | "already_claimed"
    | "identity_conflict"
    | "expired"
}

function browserFailure(
  row: Locked | null,
  input: BrowserOwner,
  controller = true
): Failure | null {
  if (
    !row ||
    row.attempt.accountId !== input.accountId ||
    row.call.accountId !== input.accountId
  )
    return { kind: "not_found" }
  if (row.attempt.initiatedByUserId !== input.userId)
    return { kind: "not_owner" }
  if (
    controller &&
    !secretsMatch(row.attempt.controllerProofHash, input.controllerProofHash)
  )
    return { kind: "invalid_controller" }
  return null
}

async function bounded<T>(
  operation: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error("Sandbox transport timeout"))
        }, LIMITS.dispatchMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function validJoin(join: SandboxJoin, now: Date): boolean {
  if (
    !validSandboxIdentity(join.sessionId) ||
    typeof join.dailyToken !== "string" ||
    join.dailyToken.length < 1 ||
    join.dailyToken.length > 16384 ||
    typeof join.dailyRoom !== "string" ||
    join.dailyRoom.length > 2048 ||
    !Number.isFinite(Date.parse(join.expiresAt)) ||
    Date.parse(join.expiresAt) <= now.getTime()
  )
    return false
  try {
    const url = new URL(join.dailyRoom)
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      url.hostname.endsWith(".daily.co")
    )
  } catch {
    return false
  }
}

function normalizeStart(
  value: Awaited<ReturnType<SandboxTransport["start"]>>
): Awaited<ReturnType<SandboxTransport["start"]>> {
  if (!value || typeof value !== "object") return { kind: "unknown" }
  if (value.kind === "definite_no_start") return value
  if (value.kind === "started" && value.join && typeof value.join === "object")
    return value
  return { kind: "unknown" }
}

function normalizeRead(
  value: Awaited<ReturnType<SandboxTransport["read"]>>
): Awaited<ReturnType<SandboxTransport["read"]>> {
  if (!value || typeof value !== "object") return { kind: "unknown" }
  if (value.kind === "forbidden" || value.kind === "not_found") return value
  if (
    value.kind === "session" &&
    validSandboxIdentity(value.sessionId) &&
    value.binding &&
    [
      value.binding.organizationId,
      value.binding.serviceId,
      value.binding.deploymentId,
      value.binding.agentName,
    ].every(validSandboxIdentity) &&
    (value.state === "running" || value.state === "stopped")
  )
    return value
  return { kind: "unknown" }
}

/**
 * Production exports the no-transport instance below. No environment variable,
 * browser argument or route can opt into dispatch. Explicit dependency injection
 * exercises the durable offline protocol, not provider capability or admission.
 */
export function createSandboxLifecycle(offline?: {
  transport: SandboxTransport
  binding: SandboxBinding
  apiBase: string
  now?: () => Date
}) {
  if (offline && !Object.values(offline.binding).every(validSandboxIdentity))
    throw new Error("Invalid independent Sandbox binding.")
  const now = () => offline?.now?.() ?? new Date()

  async function dispatch(input: BrowserOwner) {
    if (!offline) return refuseDisabledSandboxExecution(input)
    await expireSandboxReservations(now())
    const decision = await getDb().transaction(async (tx) => {
      const row = await locked(tx, input.attemptId)
      const denied = browserFailure(row, input)
      if (denied || !row) return denied ?? { kind: "not_found" as const }
      if (
        row.attempt.state !== "prepared" ||
        row.attempt.reservationExpiresAt <= now()
      )
        return { kind: "unchanged" as const }
      const at = now()
      const token = mintAgentToken()
      await tx
        .update(sandboxAttempts)
        .set({
          state: "dispatching",
          protocol: SANDBOX_PROTOCOL,
          dispatchedAt: at,
          resourceState: "possible",
          startupDeadline: new Date(at.getTime() + LIMITS.startupMs),
          presenceExpiresAt: new Date(at.getTime() + LIMITS.presenceMs),
        })
        .where(eq(sandboxAttempts.id, input.attemptId))
      await tx
        .update(calls)
        .set({
          agentTokenHash: token.hash,
          state: "starting",
          executionDeadline: new Date(at.getTime() + LIMITS.executionMs),
        })
        .where(eq(calls.id, row.call.id))
      return {
        kind: "dispatch" as const,
        callId: row.call.id,
        agentToken: token.raw,
        executionDeadline: new Date(at.getTime() + LIMITS.executionMs),
      }
    })
    if (decision.kind !== "dispatch") return decision
    let result: Awaited<ReturnType<SandboxTransport["start"]>>
    try {
      result = normalizeStart(
        await bounded((signal) =>
          offline.transport.start(
            {
              callId: decision.callId,
              apiBase: offline.apiBase,
              agentToken: decision.agentToken,
            },
            signal,
            {
              executionDeadline: decision.executionDeadline,
              retainSession: async (sessionId) => {
                if (!validSandboxIdentity(sessionId))
                  throw new Error("Invalid Sandbox session identity.")
                await getDb().transaction(async (tx) => {
                  const row = (await locked(tx, input.attemptId))!
                  const at = now()
                  await tx
                    .insert(sandboxSessions)
                    .values({
                      attemptId: input.attemptId,
                      sessionId,
                      nextReconcileAt: at,
                    })
                    .onConflictDoNothing()
                  if (
                    row.attempt.runtimeSessionId &&
                    row.attempt.runtimeSessionId !== sessionId
                  ) {
                    await tx
                      .update(sandboxAttempts)
                      .set({ identityConflictAt: at })
                      .where(eq(sandboxAttempts.id, input.attemptId))
                    await stopIntent(tx, row, "identity_conflict", at)
                  }
                })
              },
            }
          )
        )
      )
    } catch {
      result = { kind: "unknown" }
    }
    await getDb().transaction(async (tx) => {
      const row = (await locked(tx, input.attemptId))!
      const at = now()
      await advance(tx, row, at)
      await tx
        .update(sandboxAttempts)
        .set({ dispatchSettledAt: at })
        .where(eq(sandboxAttempts.id, input.attemptId))
      const retained = await tx
        .select({ sessionId: sandboxSessions.sessionId })
        .from(sandboxSessions)
        .where(eq(sandboxSessions.attemptId, input.attemptId))
        .limit(1)
      if (
        result.kind === "definite_no_start" &&
        !row.attempt.runtimeSessionId &&
        retained.length === 0
      ) {
        await tx
          .update(sandboxAttempts)
          .set({
            state: "failed",
            resourceState: "confirmed_stopped",
            joinCiphertext: null,
          })
          .where(eq(sandboxAttempts.id, input.attemptId))
        await tx
          .update(calls)
          .set({
            state: "failed",
            endedAt: at,
            endedReason: "provider_rejected",
          })
          .where(eq(calls.id, row.call.id))
        await tx
          .delete(sandboxSlots)
          .where(eq(sandboxSlots.attemptId, input.attemptId))
        return
      }
      if (
        result.kind === "started" &&
        validSandboxIdentity(result.join?.sessionId)
      ) {
        const sessionId = result.join.sessionId
        await tx
          .insert(sandboxSessions)
          .values({
            attemptId: input.attemptId,
            sessionId,
            nextReconcileAt: at,
          })
          .onConflictDoNothing()
        const conflict =
          row.attempt.runtimeSessionId !== null &&
          row.attempt.runtimeSessionId !== sessionId
        if (conflict) {
          await tx
            .update(sandboxAttempts)
            .set({ identityConflictAt: at })
            .where(eq(sandboxAttempts.id, input.attemptId))
          await stopIntent(tx, row, "identity_conflict", at)
        }
        if (
          !conflict &&
          !row.attempt.stopRequestedAt &&
          !isTerminal(row.call) &&
          validJoin(result.join, at)
        ) {
          let joinCiphertext: string
          try {
            joinCiphertext = encryptSecret(
              JSON.stringify({
                attemptId: input.attemptId,
                callId: row.call.id,
                join: result.join,
              })
            )
          } catch {
            // Do not roll back the exact identity just learned from start.
            // Losing encryption means stop, not losing the cleanup target.
            await stopIntent(tx, row, "join_unavailable", at)
            return
          }
          await tx
            .update(calls)
            .set({ pipecatSessionId: sessionId })
            .where(eq(calls.id, row.call.id))
          await tx
            .update(sandboxAttempts)
            .set({
              state: "starting",
              resourceState: "known_running",
              joinCiphertext,
              joinExpiresAt: new Date(result.join.expiresAt),
            })
            .where(eq(sandboxAttempts.id, input.attemptId))
          return
        }
      }
      await stopIntent(tx, row, "start_unknown", at)
      if (row.attempt.stopReason === "start_unknown")
        await tx
          .update(sandboxAttempts)
          .set({ state: "start_unknown" })
          .where(eq(sandboxAttempts.id, input.attemptId))
    })
    await reconcile(input.attemptId)
    return { kind: "processed" as const }
  }

  async function register(input: Agent): Promise<Failure | { kind: "ok" }> {
    if (
      !validSandboxIdentity(input.owner.sessionId) ||
      !validSandboxIdentity(input.owner.bootId)
    )
      return { kind: "unavailable" }
    return getDb().transaction(async (tx) => {
      const row = await agentLocked(tx, input)
      if (!row) return { kind: "not_found" }
      const at = now()
      await advance(tx, row, at)
      if (
        row.attempt.resourceState === "confirmed_stopped" ||
        (row.attempt.reportingUntil && row.attempt.reportingUntil <= at)
      )
        return { kind: "expired" }
      // Late authenticated identity is useful for exact cleanup but never a new owner.
      await tx
        .insert(sandboxSessions)
        .values({
          attemptId: row.attempt.id,
          sessionId: input.owner.sessionId,
          nextReconcileAt: at,
        })
        .onConflictDoNothing()
      if (row.attempt.identityConflictAt) return { kind: "identity_conflict" }
      if (
        (row.attempt.runtimeSessionId && !owns(row, input.owner)) ||
        (row.call.pipecatSessionId &&
          row.call.pipecatSessionId !== input.owner.sessionId)
      ) {
        await tx
          .update(sandboxAttempts)
          .set({ identityConflictAt: at })
          .where(eq(sandboxAttempts.id, row.attempt.id))
        await stopIntent(tx, row, "identity_conflict", at)
        return { kind: "identity_conflict" }
      }
      if (row.attempt.stopRequestedAt || isTerminal(row.call))
        return { kind: "expired" }
      if (!row.attempt.runtimeSessionId)
        await tx
          .update(sandboxAttempts)
          .set({
            runtimeSessionId: input.owner.sessionId,
            runtimeBootId: input.owner.bootId,
          })
          .where(eq(sandboxAttempts.id, row.attempt.id))
      return { kind: "ok" }
    })
  }

  async function claim(
    input: Agent,
    apiBase: string
  ): Promise<Failure | { kind: "ok"; config: SandboxConfig }> {
    return getDb().transaction(async (tx) => {
      const row = await agentLocked(tx, input)
      if (!row || !owns(row, input.owner)) return { kind: "not_found" }
      const at = now()
      await advance(tx, row, at)
      if (
        row.attempt.stopRequestedAt ||
        isTerminal(row.call) ||
        row.attempt.identityConflictAt
      )
        return { kind: "expired" }
      if (row.call.configClaimedAt) return { kind: "already_claimed" }
      const snapshot = row.call
        .practiceSnapshot as FrozenPracticeSnapshot | null
      if (!snapshot || row.call.testMode !== "practice")
        return { kind: "unavailable" }
      const secret = createPracticeSecret()
      await tx
        .update(calls)
        .set({
          configClaimedAt: at,
          state: "active",
          startedAt: at,
          lastHeartbeatAt: at,
          practiceSecretCiphertext: secret.ciphertext,
        })
        .where(eq(calls.id, row.call.id))
      return {
        kind: "ok",
        config: {
          protocol: SANDBOX_PROTOCOL,
          owner: input.owner,
          control: control(row, at),
          config: {
            assistantId: snapshot.assistantId,
            voice: snapshot.voice,
            instructions: snapshot.instructions,
            accentStyle: snapshot.accentStyle,
            waitingBehavior: snapshot.waitingBehavior,
            backendModel: snapshot.backendModel,
            backendInstructions: snapshot.backendInstructions,
            tools: snapshot.tools.map((tool) => ({
              type: "function" as const,
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              },
            })),
            serverUrl: practiceToolUrl(apiBase, row.call.id),
            serverSecret: secret.plaintext,
            webhookTimeoutSecs: WEBHOOK_TIMEOUT_SECS,
            functionCallTimeoutSecs: FUNCTION_CALL_TIMEOUT_SECS,
            delegationTimeoutSecs: DELEGATION_TIMEOUT_SECS,
          },
        },
      }
    })
  }

  async function poll(
    input: Agent
  ): Promise<
    | Failure
    | { kind: "ok"; protocol: typeof SANDBOX_PROTOCOL; control: SandboxControl }
  > {
    return getDb().transaction(async (tx) => {
      const row = await agentLocked(tx, input)
      if (!row || !owns(row, input.owner)) return { kind: "not_found" }
      const at = now()
      await advance(tx, row, at)
      if (
        isTerminal(row.call) &&
        (!row.attempt.reportingUntil || row.attempt.reportingUntil <= at)
      )
        return { kind: "expired" }
      if (!row.attempt.stopRequestedAt)
        await tx
          .update(calls)
          .set({ lastHeartbeatAt: at })
          .where(eq(calls.id, row.call.id))
      return {
        kind: "ok",
        protocol: SANDBOX_PROTOCOL,
        control: control(row, at),
      }
    })
  }

  /** A04 calls this only after its authenticated three-part readiness barrier. */
  async function markReady(input: Agent): Promise<Failure | { kind: "ok" }> {
    return getDb().transaction(async (tx) => {
      const row = await agentLocked(tx, input)
      if (!row || !owns(row, input.owner)) return { kind: "not_found" }
      await advance(tx, row, now())
      if (
        !row.call.configClaimedAt ||
        row.attempt.stopRequestedAt ||
        isTerminal(row.call)
      )
        return { kind: "expired" }
      if (!row.attempt.readyAt)
        await tx
          .update(sandboxAttempts)
          .set({ readyAt: now(), state: "active" })
          .where(eq(sandboxAttempts.id, row.attempt.id))
      return { kind: "ok" }
    })
  }

  async function join(
    input: BrowserOwner
  ): Promise<
    | Failure
    | { kind: "ok"; join: SandboxJoin }
    | Awaited<ReturnType<typeof refuseDisabledSandboxExecution>>
  > {
    if (!offline) return refuseDisabledSandboxExecution(input)
    return getDb().transaction(async (tx) => {
      const row = await locked(tx, input.attemptId)
      const denied = browserFailure(row, input)
      if (denied || !row) return denied ?? { kind: "not_found" }
      await advance(tx, row, now())
      if (
        row.attempt.stopRequestedAt ||
        isTerminal(row.call) ||
        !row.attempt.joinCiphertext ||
        !row.attempt.joinExpiresAt ||
        row.attempt.joinExpiresAt <= now()
      )
        return { kind: "unavailable" }
      try {
        const envelope = JSON.parse(
          decryptSecret(row.attempt.joinCiphertext)
        ) as { attemptId: string; callId: string; join: SandboxJoin }
        if (
          envelope.attemptId !== row.attempt.id ||
          envelope.callId !== row.call.id
        )
          return { kind: "unavailable" }
        const join = envelope.join
        if (
          !validJoin(join, now()) ||
          join.sessionId !== row.call.pipecatSessionId
        )
          return { kind: "unavailable" }
        return { kind: "ok", join }
      } catch {
        return { kind: "unavailable" }
      }
    })
  }

  async function presence(input: BrowserOwner) {
    if (!offline) return refuseDisabledSandboxExecution(input)
    return getDb().transaction(async (tx) => {
      const row = await locked(tx, input.attemptId)
      const denied = browserFailure(row, input)
      if (denied || !row) return denied ?? { kind: "not_found" as const }
      const at = now()
      await advance(tx, row, at)
      if (
        !row.attempt.dispatchedAt ||
        row.attempt.stopRequestedAt ||
        isTerminal(row.call)
      )
        return { kind: "expired" as const }
      const expires = new Date(
        Math.min(
          at.getTime() + LIMITS.presenceMs,
          row.call.executionDeadline!.getTime()
        )
      )
      await tx
        .update(sandboxAttempts)
        .set({ presenceExpiresAt: expires })
        .where(eq(sandboxAttempts.id, input.attemptId))
      return { kind: "ok" as const, presenceExpiresAt: expires.toISOString() }
    })
  }

  async function stop(input: Omit<BrowserOwner, "controllerProofHash">) {
    const canceled = await cancelSandboxAttempt({ ...input, now: now() })
    if (canceled.kind !== "provider_cleanup_disabled") return canceled
    await getDb().transaction(async (tx) => {
      const row = await locked(tx, input.attemptId)
      if (
        !row ||
        browserFailure(row, { ...input, controllerProofHash: "" }, false) ||
        !row.attempt.dispatchedAt
      )
        return
      const at = now()
      await advance(tx, row, at)
      await stopIntent(tx, row, "user_stopped", at)
    })
    await reconcile(input.attemptId)
    const attempt = await getSandboxAttemptForAccount({
      accountId: input.accountId,
      attemptId: input.attemptId,
      now: now(),
    })
    return { ...canceled, attempt: attempt ?? canceled.attempt }
  }

  async function reconcile(attemptId: string): Promise<void> {
    await getDb().transaction(async (tx) => {
      const row = await locked(tx, attemptId)
      if (row) {
        await advance(tx, row, now())
        await tx
          .update(sandboxAttempts)
          .set({ reconciledAt: now() })
          .where(eq(sandboxAttempts.id, attemptId))
      }
    })
    if (!offline) return
    const references = await getDb()
      .select()
      .from(sandboxSessions)
      .where(eq(sandboxSessions.attemptId, attemptId))
    for (const reference of references) {
      const leaseToken = randomUUID()
      const lease = await getDb().transaction(async (tx) => {
        const row = await locked(tx, attemptId)
        if (!row?.attempt.stopRequestedAt) return false
        const updated = await tx
          .update(sandboxSessions)
          .set({
            reconcileToken: leaseToken,
            nextReconcileAt: new Date(now().getTime() + 60_000),
          })
          .where(
            and(
              eq(sandboxSessions.attemptId, attemptId),
              eq(sandboxSessions.sessionId, reference.sessionId),
              eq(sandboxSessions.reconciliationBlocked, false),
              ne(sandboxSessions.resourceState, "confirmed_stopped"),
              lte(sandboxSessions.nextReconcileAt, now())
            )
          )
          .returning()
        return updated.length === 1
      })
      if (!lease) continue
      let evidence: Awaited<ReturnType<SandboxTransport["read"]>>
      try {
        evidence = normalizeRead(
          await bounded((signal) =>
            offline.transport.read(reference.sessionId, signal)
          )
        )
      } catch {
        evidence = { kind: "unknown" }
      }
      const matched =
        evidence.kind === "session" &&
        evidence.sessionId === reference.sessionId &&
        evidence.binding.organizationId === offline.binding.organizationId &&
        evidence.binding.serviceId === offline.binding.serviceId &&
        evidence.binding.deploymentId === offline.binding.deploymentId &&
        evidence.binding.agentName === offline.binding.agentName
      const blocked =
        evidence.kind === "forbidden" ||
        (evidence.kind === "session" && !matched)
      const terminal =
        matched && evidence.kind === "session" && evidence.state === "stopped"
      const retryDelay = await getDb().transaction(async (tx) => {
        await locked(tx, attemptId)
        const [session] = await tx
          .select()
          .from(sandboxSessions)
          .where(
            and(
              eq(sandboxSessions.attemptId, attemptId),
              eq(sandboxSessions.sessionId, reference.sessionId)
            )
          )
        if (!session || session.reconcileToken !== leaseToken) return null
        const sendStop = matched && !terminal && session.stopAttempts < 3
        await tx
          .update(sandboxSessions)
          .set({
            resourceState: terminal
              ? "confirmed_stopped"
              : matched
                ? "stop_requested"
                : session.resourceState,
            confirmedStoppedAt: terminal ? now() : null,
            reconciliationBlocked: blocked,
            stopAttempts: session.stopAttempts + (sendStop ? 1 : 0),
            nextReconcileAt: new Date(
              now().getTime() + (sendStop ? 60_000 : 15_000)
            ),
          })
          .where(
            and(
              eq(sandboxSessions.attemptId, attemptId),
              eq(sandboxSessions.sessionId, reference.sessionId)
            )
          )
        return sendStop ? (session.stopAttempts === 0 ? 5_000 : 15_000) : null
      })
      // Count committed before mutation: a crashed/lost DELETE consumes its try.
      if (retryDelay !== null) {
        try {
          await bounded((signal) =>
            offline.transport.stop(reference.sessionId, signal)
          )
        } catch {
          /* Never infer termination from the DELETE result. */
        }
        await getDb()
          .update(sandboxSessions)
          .set({
            nextReconcileAt: new Date(now().getTime() + retryDelay),
          })
          .where(
            and(
              eq(sandboxSessions.attemptId, attemptId),
              eq(sandboxSessions.sessionId, reference.sessionId),
              eq(sandboxSessions.reconcileToken, leaseToken)
            )
          )
      }
    }
    // A stop can be proved while the start request is still settling. Revisit
    // already-confirmed references after settlement; never release mid-dispatch.
    await getDb().transaction(async (tx) => {
      const row = await locked(tx, attemptId)
      if (!row?.attempt.dispatchSettledAt || !row.attempt.stopRequestedAt)
        return
      const sessions = await tx
        .select()
        .from(sandboxSessions)
        .where(eq(sandboxSessions.attemptId, attemptId))
      if (
        !sessions.length ||
        sessions.some(
          (session) => session.resourceState !== "confirmed_stopped"
        )
      )
        return
      await tx
        .update(sandboxAttempts)
        .set({ resourceState: "confirmed_stopped", joinCiphertext: null })
        .where(eq(sandboxAttempts.id, attemptId))
      await tx.delete(sandboxSlots).where(eq(sandboxSlots.attemptId, attemptId))
      if (!isTerminal(row.call)) {
        await tx
          .update(calls)
          .set({
            state: row.call.configClaimedAt ? "incomplete" : "failed",
            endedAt: now(),
            endedReason: "resource_stopped",
          })
          .where(eq(calls.id, row.call.id))
        await tx
          .update(sandboxAttempts)
          .set({
            reportingUntil: new Date(now().getTime() + LIMITS.reportingGraceMs),
          })
          .where(eq(sandboxAttempts.id, attemptId))
      }
    })
  }

  async function sweep(): Promise<number> {
    const rows = await getDb()
      .select({ id: sandboxAttempts.id })
      .from(sandboxAttempts)
      .where(
        and(
          ne(sandboxAttempts.resourceState, "not_dispatched"),
          ne(sandboxAttempts.resourceState, "confirmed_stopped")
        )
      )
      .orderBy(
        sql`${sandboxAttempts.reconciledAt} asc nulls first`,
        sandboxAttempts.id
      )
      .limit(100)
    for (const row of rows) await reconcile(row.id)
    return rows.length
  }

  async function status(input: { accountId: string; attemptId: string }) {
    const scoped = await getSandboxAttemptForAccount({ ...input, now: now() })
    if (!scoped) return null
    await reconcile(input.attemptId)
    return getSandboxAttemptForAccount({ ...input, now: now() })
  }

  async function current(input: { accountId: string; userId: string }) {
    const attempt = await getCurrentSandboxAttempt({ ...input, now: now() })
    return attempt
      ? status({ accountId: input.accountId, attemptId: attempt.attemptId })
      : null
  }

  return {
    dispatch,
    register,
    claim,
    control: poll,
    markReady,
    join,
    presence,
    stop,
    reconcile,
    sweep,
    status,
    current,
  }
}

export const sandboxLifecycle = createSandboxLifecycle()
