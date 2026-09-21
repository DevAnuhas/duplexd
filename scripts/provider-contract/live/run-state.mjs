import { safeReference } from "../lib/contract.mjs"

export const LIMITS = Object.freeze({
  maxStarts: 6,
  maxConcurrent: 1,
  maxBilledMinutes: 72,
  maxBilledMinutesPerSession: 12,
  startupSeconds: 120,
  wholeSessionSeconds: 600,
})

export const BASELINE = Object.freeze({
  agentName: "duplexd-agent",
  deploymentId: "95a4b2b4",
  buildId: "3010f496",
  imageDigest:
    "sha256:032aa1f121bc91a22748c725966bfd21e6659daaf8b159d367fd6e0f7a745242",
  minAgents: 0,
  maxAgents: 3,
  privateKeyCount: 0,
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
    }, LIMITS.wholeSessionSeconds * 1_000)
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

  recordRegistration(caseId, sessionId) {
    const attempt = this.#required(caseId)
    attempt.registrationSessionId = sessionId
    if (attempt.sessionId !== null && attempt.sessionId !== sessionId) {
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
    return {
      caseId,
      sessionRef:
        attempt.sessionId === null ? null : safeReference(attempt.sessionId),
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
    return [...this.#active.values()]
      .map((attempt) => attempt.sessionId ?? attempt.registrationSessionId)
      .filter((value) => value !== null)
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

export function verifyRollback({ manifest, sessions, keys }) {
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
  return { ok: errors.length === 0, errors }
}

export async function abortAndRestore({
  state,
  stopSession,
  restoreBaseline,
  revokePrivateKey,
  readback,
}) {
  state.abort()
  const cleanupErrors = []
  for (const sessionId of new Set(state.emergencySessionIds())) {
    try {
      await stopSession(sessionId)
    } catch (error) {
      cleanupErrors.push(`stop failed: ${String(error)}`)
    }
  }
  try {
    await restoreBaseline()
  } catch (error) {
    cleanupErrors.push(`baseline restore failed: ${String(error)}`)
  }
  try {
    await revokePrivateKey()
  } catch (error) {
    cleanupErrors.push(`private-key revocation failed: ${String(error)}`)
  }
  let verification = { ok: false, errors: ["readback did not run"] }
  try {
    verification = verifyRollback(await readback())
  } catch (error) {
    cleanupErrors.push(`rollback readback failed: ${String(error)}`)
  }
  return {
    ok: cleanupErrors.length === 0 && verification.ok,
    cleanupErrors,
    verification,
  }
}

export function createOperatorGuard({ state = new LiveRunState(), cleanup }) {
  if (typeof cleanup !== "function") {
    throw new TypeError("operator cleanup function is required")
  }
  let cleanupPromise = null

  function abort(reason) {
    if (cleanupPromise === null) {
      state.abort()
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
    cleanupResult() {
      return cleanupPromise
    },
  }
}
