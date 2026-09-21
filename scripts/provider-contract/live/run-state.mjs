import { safeReference } from "../lib/contract.mjs"

export const LIMITS = Object.freeze({
  maxStarts: 6,
  maxConcurrent: 1,
  maxBilledMinutes: 72,
  maxBilledMinutesPerSession: 12,
  startupSeconds: 120,
  providerMaxSessionSeconds: 600,
  operatorContainmentSeconds: 720,
  ambiguousReconciliationSeconds: 60,
  reconciliationPollSeconds: 5,
})

export const BASELINE = Object.freeze({
  agentName: "duplexd-agent",
  deploymentId: "95a4b2b4-6fed-47c8-8539-e820347f35fe",
  buildId: "3010f496-fd84-4f39-a75c-c4a58a1bd922",
  imageDigest:
    "sha256:032aa1f121bc91a22748c725966bfd21e6659daaf8b159d367fd6e0f7a745242",
  minAgents: 0,
  maxAgents: 3,
  privateKeyCount: 0,
  secretSet: "duplexd-agent-secrets",
})

export class LiveRunState {
  #started = 0
  #active = new Map()
  #billedMinutes = 0
  #aborted = false
  #schedule
  #cancel

  constructor({
    schedule = (callback, milliseconds) => setTimeout(callback, milliseconds),
    cancel = (timer) => clearTimeout(timer),
  } = {}) {
    this.#schedule = schedule
    this.#cancel = cancel
  }

  beginCase(
    caseId,
    { onStartupTimeout = () => {}, onWholeTimeout = () => {} } = {}
  ) {
    if (this.#aborted) throw new Error("run is aborted")
    if (this.#started >= LIMITS.maxStarts) {
      throw new Error("six-session start limit reached")
    }
    if (this.#active.size >= LIMITS.maxConcurrent) {
      throw new Error("serial-session concurrency limit reached")
    }
    if (
      this.#billedMinutes + LIMITS.maxBilledMinutesPerSession >
      LIMITS.maxBilledMinutes
    ) {
      throw new Error("billed-minute limit reached")
    }
    this.#started += 1
    const attempt = {
      caseId,
      startedAt: Date.now(),
      sessionId: null,
      operatorSessionId: null,
      registrationSessionId: null,
      endedAt: null,
      ready: false,
      startupTimer: null,
      wholeTimer: null,
    }
    attempt.startupTimer = this.#schedule(() => {
      this.#aborted = true
      onStartupTimeout(caseId)
    }, LIMITS.startupSeconds * 1_000)
    attempt.wholeTimer = this.#schedule(() => {
      this.#aborted = true
      onWholeTimeout(caseId)
    }, LIMITS.operatorContainmentSeconds * 1_000)
    attempt.startupTimer?.unref?.()
    attempt.wholeTimer?.unref?.()
    this.#active.set(caseId, attempt)
    return attempt
  }

  recordStart(caseId, sessionId) {
    const attempt = this.#required(caseId)
    if (attempt.sessionId !== null && attempt.sessionId !== sessionId) {
      throw new Error("case already owns another provider session")
    }
    attempt.sessionId = sessionId
  }

  recordOperatorWitness(caseId, sessionId) {
    const attempt = this.#required(caseId)
    if (
      (attempt.sessionId !== null && attempt.sessionId !== sessionId) ||
      (attempt.operatorSessionId !== null &&
        attempt.operatorSessionId !== sessionId)
    ) {
      throw new Error("operator witness does not match provider session")
    }
    attempt.operatorSessionId = sessionId
  }

  recordRegistration(caseId, sessionId) {
    const attempt = this.#required(caseId)
    attempt.registrationSessionId = sessionId
    if (
      (attempt.sessionId !== null && attempt.sessionId !== sessionId) ||
      (attempt.operatorSessionId !== null &&
        attempt.operatorSessionId !== sessionId)
    ) {
      throw new Error("runner registration does not match start session")
    }
  }

  markReady(caseId) {
    const attempt = this.#required(caseId)
    attempt.ready = true
    if (attempt.startupTimer !== null) {
      this.#cancel(attempt.startupTimer)
      attempt.startupTimer = null
    }
  }

  cancelStartupDeadline(caseId) {
    const attempt = this.#required(caseId)
    if (attempt.startupTimer !== null) {
      this.#cancel(attempt.startupTimer)
      attempt.startupTimer = null
    }
  }

  finishCase(caseId, { billedMinutes, endedAt = Date.now() }) {
    const attempt = this.#required(caseId)
    if (!Number.isFinite(billedMinutes) || billedMinutes < 0) {
      throw new Error("billed minutes must be a non-negative number")
    }
    if (billedMinutes > LIMITS.maxBilledMinutesPerSession) {
      this.#aborted = true
      throw new Error("per-session billed-minute limit exceeded")
    }
    this.#billedMinutes += billedMinutes
    if (this.#billedMinutes > LIMITS.maxBilledMinutes) {
      this.#aborted = true
      throw new Error("72 billed session-minute limit exceeded")
    }
    this.#clearTimers(attempt)
    attempt.endedAt = endedAt
    this.#active.delete(caseId)
    const effectiveSessionId =
      attempt.sessionId ?? attempt.registrationSessionId
    return {
      caseId,
      sessionRef:
        effectiveSessionId === null ? null : safeReference(effectiveSessionId),
      registrationRef:
        attempt.registrationSessionId === null
          ? null
          : safeReference(attempt.registrationSessionId),
      startedAt: new Date(attempt.startedAt).toISOString(),
      endedAt: new Date(endedAt).toISOString(),
      billedMinutes,
    }
  }

  abort() {
    this.#aborted = true
    for (const attempt of this.#active.values()) {
      this.#clearTimers(attempt)
    }
  }

  emergencySessionIds() {
    return [
      ...new Set(
        [...this.#active.values()].flatMap((attempt) =>
          [
            attempt.sessionId,
            attempt.registrationSessionId,
            attempt.operatorSessionId,
          ].filter((value) => value !== null)
        )
      ),
    ]
  }

  counters() {
    return {
      started: this.#started,
      active: this.#active.size,
      billedMinutes: this.#billedMinutes,
      aborted: this.#aborted,
    }
  }

  #required(caseId) {
    const attempt = this.#active.get(caseId)
    if (attempt === undefined) {
      throw new Error(`case ${caseId} is not active`)
    }
    return attempt
  }

  #clearTimers(attempt) {
    for (const field of ["startupTimer", "wholeTimer"]) {
      if (attempt[field] !== null) {
        this.#cancel(attempt[field])
        attempt[field] = null
      }
    }
  }
}

export function verifyRollback({ manifest, sessions, keys, secretSets = [] }) {
  const errors = []
  if (manifest.agentName !== BASELINE.agentName) {
    errors.push("baseline agent mismatch")
  }
  if (manifest.buildId !== BASELINE.buildId)
    errors.push("baseline build mismatch")
  if (manifest.imageDigest !== BASELINE.imageDigest) {
    errors.push("baseline image digest mismatch")
  }
  if (
    manifest.minAgents !== BASELINE.minAgents ||
    manifest.maxAgents !== BASELINE.maxAgents
  ) {
    errors.push("baseline scaling mismatch")
  }
  if (manifest.secretSet !== BASELINE.secretSet) {
    errors.push("baseline secret-set reference mismatch")
  }
  if (Object.hasOwn(manifest, "maxSessionDurationSeconds")) {
    errors.push("duration override was not removed")
  }
  if (!Array.isArray(sessions) || sessions.length !== 0) {
    errors.push("provider still has active sessions")
  }
  if (
    !Array.isArray(keys) ||
    keys.some(
      (key) => key?.name === "Stage A provider proof" || key?.type === "private"
    )
  ) {
    errors.push("temporary private key still exists")
  }
  if (
    !Array.isArray(secretSets) ||
    secretSets.some((set) => set?.name === "duplexd-provider-proof")
  ) {
    errors.push("temporary probe secret set still exists")
  }
  return { ok: errors.length === 0, errors }
}

export async function abortAndRestore({
  state,
  stopSession,
  restoreBaseline,
  revokePrivateKey,
  deleteProbeSecretSet,
  readback,
}) {
  state.abort()
  const cleanupErrors = []
  const volatileKnownSessionIds = [...new Set(state.emergencySessionIds())]
  const containment = {
    knownSessionRefs: volatileKnownSessionIds.map(safeReference),
    baselineRestored: false,
    privateKeyRevoked: false,
    probeSecretSetDeleted: false,
  }
  for (const sessionId of volatileKnownSessionIds) {
    try {
      await stopSession(sessionId)
    } catch {
      cleanupErrors.push("exact-session stop failed")
    }
  }
  try {
    await restoreBaseline()
    containment.baselineRestored = true
  } catch {
    cleanupErrors.push("baseline restore failed")
  }
  try {
    await revokePrivateKey()
    containment.privateKeyRevoked = true
  } catch {
    cleanupErrors.push("private-key revocation failed")
  }
  if (containment.baselineRestored) {
    try {
      await deleteProbeSecretSet()
      containment.probeSecretSetDeleted = true
    } catch {
      cleanupErrors.push("probe secret-set deletion failed")
    }
  } else {
    cleanupErrors.push(
      "probe secret-set deletion skipped because baseline restoration failed"
    )
  }
  let verification = { ok: false, errors: ["readback did not run"] }
  let volatileProviderState = null
  try {
    volatileProviderState = await readback()
    verification = verifyRollback(volatileProviderState)
    containment.activeSessionRefs = (volatileProviderState.sessions ?? []).map(
      (session) => safeReference(session.sessionId)
    )
  } catch {
    cleanupErrors.push("rollback readback failed")
  }
  return {
    ok: cleanupErrors.length === 0 && verification.ok,
    cleanupErrors,
    verification,
    containment,
    volatileKnownSessionIds,
    volatileProviderState,
  }
}

export function createOperatorGuard({ state = new LiveRunState(), cleanup }) {
  if (typeof cleanup !== "function") {
    throw new TypeError("operator cleanup function is required")
  }
  let cleanupPromise = null
  let resolveAbort
  const controller = new AbortController()
  const abortSignal = new Promise((resolve) => {
    resolveAbort = resolve
  })

  function abort(reason) {
    if (cleanupPromise === null) {
      state.abort()
      controller.abort(reason)
      resolveAbort(reason)
      cleanupPromise = Promise.resolve().then(() => cleanup(reason))
      void cleanupPromise.catch(() => {})
    }
    return cleanupPromise
  }

  return {
    state,
    beginCase(caseId) {
      try {
        return state.beginCase(caseId, {
          onStartupTimeout: () => void abort("startup_timeout"),
          onWholeTimeout: () => void abort("whole_session_timeout"),
        })
      } catch (error) {
        void abort("start_guard_rejected")
        throw error
      }
    },
    finishCase(caseId, result) {
      try {
        return state.finishCase(caseId, result)
      } catch (error) {
        void abort("billing_guard_rejected")
        throw error
      }
    },
    abort,
    abortSignal,
    signal: controller.signal,
    cleanupResult() {
      return cleanupPromise
    },
  }
}
