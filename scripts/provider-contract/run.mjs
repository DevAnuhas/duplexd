#!/usr/bin/env node

import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto"
import { spawn } from "node:child_process"
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const PROBE_ROOT = join(ROOT, "scripts/provider-contract/probe")
const PROD_AGENT = "duplexd-agent"
const PROBE_AGENT = "duplexd-provider-proof"
const ORIGIN = "https://api.pipecat.daily.co"
const SCHEMA_VERSION = 1
const LIVE_RELEASE = "stage-a-disposable-probe-release"
const BASELINE = Object.freeze({
  buildId: "3010f496-fd84-4f39-a75c-c4a58a1bd922",
  imageDigest:
    "sha256:032aa1f121bc91a22748c725966bfd21e6659daaf8b159d367fd6e0f7a745242",
  minAgents: 0,
  maxAgents: 3,
  secretSet: "duplexd-agent-secrets",
})
const LIMITS = Object.freeze({
  starts: 6,
  providerSeconds: 600,
  caseSeconds: 720,
  billedMinutes: 72,
})
const EVENT_KINDS = new Set([
  "run_created",
  "operation_intent",
  "operation_result",
  "callback",
  "witness_observation",
  "session_identity",
  "session_status",
  "resource_observation",
  "first_failure",
  "cleanup_result",
  "verdict",
])
const TERMINAL_STATES = new Set([
  "ended",
  "stopped",
  "failed",
  "cancelled",
  "terminated",
])

export const CASES = Object.freeze([
  { id: "cold_start", join: true, stop: "once" },
  { id: "cancel_before_join", join: false, stop: "once" },
  {
    id: "lost_start_response_registered",
    join: false,
    stop: "once",
    discard: true,
  },
  { id: "no_registration_startup", join: true, stop: "ceiling", discard: true },
  { id: "hung_runtime", join: true, stop: "ceiling" },
  { id: "known_session_stop_retry", join: false, stop: "twice" },
])

let exerciseSignal = null

const sleep = (milliseconds, signal = null) =>
  new Promise((resolvePromise, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort)
      resolvePromise()
    }
    const timer = setTimeout(finish, milliseconds)
    const abort = () => {
      clearTimeout(timer)
      reject(new Error("operator_signal"))
    }
    signal?.addEventListener("abort", abort, { once: true })
  })
const delay = (milliseconds) => sleep(milliseconds, exerciseSignal)

function isInside(path, parent) {
  const rel = relative(parent, path)
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"))
}

async function exists(path) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error?.code === "ENOENT") return false
    throw error
  }
}

async function assertOutsideWorktree(parent) {
  let current = parent
  while (true) {
    if (await exists(join(current, ".git")))
      throw new Error("run_dir_inside_git_worktree")
    const next = dirname(current)
    if (next === current) return
    current = next
  }
}

export async function validateRunDirectory(runDir) {
  if (!runDir || !resolve(runDir).startsWith("/"))
    throw new Error("run_dir_absolute_required")
  const absolute = resolve(runDir)
  const parent = await realpath(dirname(absolute))
  if (await exists(absolute)) {
    const info = await lstat(absolute)
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error("run_dir_invalid")
  }
  if (isInside(absolute, await realpath(tmpdir())))
    throw new Error("run_dir_temporary_forbidden")
  await assertOutsideWorktree(parent)
  return absolute
}

export function safeRef(salt, value) {
  return createHash("sha256")
    .update(`${salt}\0${value}`)
    .digest("hex")
    .slice(0, 24)
}

function safeCategory(error) {
  const value = String(error?.message ?? "unknown")
  if (/^provider_http_\d{3}$/u.test(value)) return value
  if (
    [
      "operator_signal",
      "callback_persist_failed",
      "journal_invalid",
      "journal_sequence_gap",
      "journal_truncated_tail",
      "ownership_unresolved",
      "ownership_mismatch",
      "session_status_unknown",
      "session_stop_exhausted",
      "session_permission_denied",
      "cleanup_deadline_exceeded",
      "usage_unknown",
    ].includes(value)
  )
    return value
  return "operation_failed"
}

async function syncDirectory(path) {
  const handle = await open(path, "r")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function atomicJson(path, value) {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  const handle = await open(temporary, "wx", 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await chmod(temporary, 0o600)
  await rename(temporary, path)
  await syncDirectory(dirname(path))
}

export async function replayJournal(path) {
  let text = ""
  try {
    text = await readFile(path, "utf8")
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
  }
  const complete = text.endsWith("\n")
    ? text
    : text.slice(0, text.lastIndexOf("\n") + 1)
  const needsContinuation = complete.length !== text.length
  let truncatedTail = needsContinuation
  const records = []
  const lines = complete.split("\n")
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line) continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      let continuation = null
      try {
        continuation = JSON.parse(lines[index + 1] ?? "")
      } catch {}
      if (
        (continuation?.kind === "first_failure" &&
          continuation?.payload?.category === "journal_truncated_tail") ||
        (continuation?.kind === "cleanup_result" &&
          continuation?.payload?.check === "journal_truncated_tail")
      ) {
        truncatedTail = true
        continue
      }
      throw new Error("journal_invalid")
    }
    if (record.sequence !== records.length + 1)
      throw new Error("journal_sequence_gap")
    if (
      record.schemaVersion !== SCHEMA_VERSION ||
      !EVENT_KINDS.has(record.kind)
    )
      throw new Error("journal_invalid")
    records.push(record)
  }
  return { records, truncatedTail, needsContinuation }
}

export function projectSummary(records, recovery, truncatedTail = false) {
  const firstFailure =
    records.find((record) => record.kind === "first_failure") ?? null
  const latestVerdict =
    records.findLast((record) => record.kind === "verdict") ?? null
  const cases = {}
  for (const record of records) {
    if (!record.caseRef) continue
    const current = cases[record.caseRef] ?? { observations: 0, callbacks: [] }
    current.observations += 1
    if (record.kind === "callback") current.callbacks.push(record.payload.event)
    if (record.kind === "session_status")
      current.lastSessionStatus = record.payload
    if (record.kind === "verdict") current.status = record.payload.status
    cases[record.caseRef] = current
  }
  const sessions = Object.values(recovery.sessions ?? {})
  const usageConfirmed =
    sessions.length > 0 &&
    sessions.every((session) => session.usageStatus === "confirmed") &&
    !(recovery.dispatches ?? []).some(
      (dispatch) => dispatch.outcome === "unknown"
    )
  const caseComplete = (definition) => {
    const observed = records.filter(
      (record) => record.caseRef === definition.id
    )
    const callbacks = new Set(
      observed
        .filter((record) => record.kind === "callback")
        .map((record) => record.payload.event)
    )
    const witnesses = new Set(
      observed
        .filter((record) => record.kind === "witness_observation")
        .map((record) => record.payload.event)
    )
    const expectedStartStatus = definition.discard ? "lost_response" : "success"
    const hasStartResult = observed.some(
      (record) =>
        record.kind === "operation_result" &&
        record.payload.name === "start_session" &&
        record.payload.status === expectedStartStatus &&
        record.payload.browserClaimsBounded === true
    )
    const sessionRefs = new Set(
      observed
        .filter(
          (record) =>
            record.kind === "session_identity" && !record.payload.conflict
        )
        .map((record) => record.payload.sessionRef)
    )
    const hasTerminalStatus = observed.some(
      (record) =>
        record.kind === "session_status" &&
        record.payload.terminal === true &&
        sessionRefs.has(record.payload.sessionRef)
    )
    const hasConfirmedUsage = observed.some(
      (record) =>
        record.kind === "resource_observation" &&
        record.payload.resource === "authoritative_usage" &&
        sessionRefs.has(record.payload.sessionRef) &&
        record.payload.usageStatus === "confirmed" &&
        Number.isFinite(record.payload.confirmedBilledMinutes)
    )
    const registrationCorrect =
      definition.id === "no_registration_startup"
        ? !callbacks.has("registered")
        : callbacks.has("registered")
    const joinCorrect =
      !definition.join ||
      (observed.some(
        (record) =>
          record.kind === "callback" &&
          record.payload.event === "agent_joined" &&
          record.payload.dailyClaimsBounded === true
      ) &&
        witnesses.has("browser_joined"))
    const ceilingCorrect =
      definition.stop !== "ceiling" ||
      (callbacks.has("agent_ejected") && witnesses.has("browser_ejected"))
    const stopCorrect =
      definition.stop === "ceiling" ||
      observed.some(
        (record) =>
          record.kind === "operation_result" &&
          record.payload.name === "stop_session"
      )
    const repeatCorrect =
      definition.stop !== "twice" ||
      observed.some(
        (record) =>
          record.kind === "operation_result" &&
          record.payload.name === "repeat_stop_session" &&
          record.payload.httpStatus === 404
      )
    const applicationIdentityCorrect =
      definition.id === "lost_start_response_registered"
        ? observed.some(
            (record) =>
              record.kind === "session_identity" &&
              record.source === "application_registration"
          )
        : definition.id !== "no_registration_startup" ||
          !observed.some(
            (record) =>
              record.kind === "session_identity" &&
              record.source === "application_registration"
          )
    return (
      cases[definition.id]?.status === "pass" &&
      hasStartResult &&
      hasTerminalStatus &&
      hasConfirmedUsage &&
      registrationCorrect &&
      joinCorrect &&
      ceilingCorrect &&
      stopCorrect &&
      repeatCorrect &&
      applicationIdentityCorrect
    )
  }
  const cleanupChecks = new Map(
    records
      .filter((record) => record.kind === "cleanup_result")
      .map((record) => [record.payload.check, record.payload.status])
  )
  const cleanupObserved =
    cleanupChecks.get("probe_service_absent") === "confirmed" &&
    cleanupChecks.get("production_unchanged") === "confirmed" &&
    cleanupChecks.get("containment") === "confirmed"
  const requirementsComplete =
    CASES.every(caseComplete) &&
    cleanupObserved &&
    recovery.cleanup?.completed === true &&
    usageConfirmed &&
    !firstFailure &&
    !truncatedTail
  const requestedStatus = latestVerdict?.payload.status ?? "incomplete"
  const status =
    requestedStatus === "pass" && !requirementsComplete
      ? "blocked"
      : requestedStatus
  return {
    schemaVersion: SCHEMA_VERSION,
    runRef: safeRef(recovery.salt, recovery.runId),
    status,
    reason:
      requestedStatus === "pass" && !requirementsComplete
        ? "required_observations_missing"
        : (latestVerdict?.payload.reason ?? null),
    journal: {
      completeRecords: records.length,
      truncatedTail,
      valid: !truncatedTail,
    },
    firstFailure: firstFailure?.payload ?? null,
    cases,
    cleanup: recovery.cleanup ?? {},
    usageStatus: usageConfirmed ? "confirmed" : "unknown",
    confirmedBilledMinutes: usageConfirmed
      ? sessions.reduce(
          (total, session) => total + session.confirmedBilledMinutes,
          0
        )
      : null,
  }
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === "EPERM"
  }
}

export class DurableRunStore {
  constructor(runDir, recovery, records, lockHandle) {
    this.runDir = runDir
    this.recovery = recovery
    this.records = records
    this.lockHandle = lockHandle
    this.startedAt = Date.now()
    this.queue = Promise.resolve()
    this.truncatedTail = false
    this.needsJournalContinuation = false
    this.closed = false
  }

  static async create(runDir, { runId, organization }) {
    const absolute = await validateRunDirectory(runDir)
    await mkdir(absolute, { mode: 0o700 })
    await chmod(absolute, 0o700)
    const lockHandle = await open(join(absolute, "writer.lock"), "wx", 0o600)
    await lockHandle.writeFile(`${JSON.stringify({ pid: process.pid })}\n`)
    await lockHandle.sync()
    const recovery = {
      schemaVersion: SCHEMA_VERSION,
      runId,
      salt: randomBytes(32).toString("base64url"),
      organization,
      serviceName: PROBE_AGENT,
      productionServiceName: PROD_AGENT,
      createdAt: new Date().toISOString(),
      starts: 0,
      dispatches: [],
      sessions: {},
      cleanup: {},
      firstFailure: null,
    }
    const store = new DurableRunStore(absolute, recovery, [], lockHandle)
    await store.persistRecovery()
    await store.append({ kind: "run_created", source: "operator", payload: {} })
    return store
  }

  static async open(runDir) {
    const absolute = await validateRunDirectory(runDir)
    const lockPath = join(absolute, "writer.lock")
    for (const name of ["recovery.json", "events.ndjson"]) {
      const info = await lstat(join(absolute, name))
      if (info.isSymbolicLink() || !info.isFile())
        throw new Error("recovery_invalid")
    }
    try {
      if ((await lstat(lockPath)).isSymbolicLink())
        throw new Error("recovery_invalid")
      const lock = JSON.parse(await readFile(lockPath, "utf8"))
      if (processAlive(lock.pid)) throw new Error("run_writer_active")
      await rm(lockPath)
    } catch (error) {
      if (error?.message === "run_writer_active") throw error
      if (error?.message === "recovery_invalid") throw error
      if (error?.code !== "ENOENT") throw error
    }
    const lockHandle = await open(lockPath, "wx", 0o600)
    await lockHandle.writeFile(`${JSON.stringify({ pid: process.pid })}\n`)
    await lockHandle.sync()
    try {
      const recovery = JSON.parse(
        await readFile(join(absolute, "recovery.json"), "utf8")
      )
      if (recovery.schemaVersion !== SCHEMA_VERSION)
        throw new Error("recovery_invalid")
      const replay = await replayJournal(join(absolute, "events.ndjson"))
      const store = new DurableRunStore(
        absolute,
        recovery,
        replay.records,
        lockHandle
      )
      store.truncatedTail = replay.truncatedTail
      store.needsJournalContinuation = replay.needsContinuation
      return store
    } catch (error) {
      await lockHandle.close()
      await rm(lockPath, { force: true })
      throw error
    }
  }

  serialize(operation) {
    const next = this.queue.then(operation)
    this.queue = next.catch(() => {})
    return next
  }

  persistRecovery() {
    return atomicJson(join(this.runDir, "recovery.json"), this.recovery)
  }

  checkpoint(mutator) {
    return this.serialize(async () => {
      mutator(this.recovery)
      await this.persistRecovery()
    })
  }

  append({ kind, source, payload, caseRef = null, operationRef = null }) {
    return this.serialize(async () => {
      if (!EVENT_KINDS.has(kind)) throw new Error("journal_invalid")
      const tailMarker =
        (kind === "first_failure" &&
          payload.category === "journal_truncated_tail") ||
        (kind === "cleanup_result" &&
          payload.check === "journal_truncated_tail")
      if (this.needsJournalContinuation && !tailMarker)
        throw new Error("journal_truncated_tail")
      const record = {
        schemaVersion: SCHEMA_VERSION,
        sequence: this.records.length + 1,
        receivedAt: new Date().toISOString(),
        elapsedMs: Date.now() - this.startedAt,
        runRef: safeRef(this.recovery.salt, this.recovery.runId),
        caseRef,
        operationRef,
        kind,
        source,
        payload,
      }
      const handle = await open(join(this.runDir, "events.ndjson"), "a", 0o600)
      try {
        const separator = this.needsJournalContinuation ? "\n" : ""
        await handle.writeFile(`${separator}${JSON.stringify(record)}\n`)
        await handle.sync()
      } finally {
        await handle.close()
      }
      this.needsJournalContinuation = false
      this.records.push(record)
      return record
    })
  }

  async latchFailure({
    caseRef = null,
    operationRef = null,
    category,
    predicate = null,
  }) {
    if (this.recovery.firstFailure) {
      if (!this.records.some((record) => record.kind === "first_failure")) {
        const failure = this.recovery.firstFailure
        await this.append({
          kind: "first_failure",
          source: "recovery",
          caseRef: failure.caseRef,
          operationRef: failure.operationRef,
          payload: { category: failure.category, predicate: failure.predicate },
        })
      }
      return
    }
    const payload = { category, predicate }
    await this.checkpoint((recovery) => {
      recovery.firstFailure ??= { ...payload, caseRef, operationRef }
    })
    await this.append({
      kind: "first_failure",
      source: "operator",
      caseRef,
      operationRef,
      payload,
    })
  }

  async writeSummary() {
    await this.queue
    const summary = projectSummary(
      this.records,
      this.recovery,
      this.truncatedTail
    )
    await atomicJson(join(this.runDir, "summary.json"), summary)
    return summary
  }

  async close() {
    if (this.closed) return
    this.closed = true
    await this.queue
    await this.lockHandle.close()
    await rm(join(this.runDir, "writer.lock"), { force: true })
  }
}

function deployBuildId(output) {
  const plain = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "")
  return plain.match(
    /\bBuild (?:ID|started):\s*([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\b/iu
  )?.[1]
}

export function deployFailureDiagnostic(
  output,
  { code, timedOut = false, salt }
) {
  const plain = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "")
  const buildId = deployBuildId(output)
  let category = "deploy_cli_exit"
  if (timedOut) category = "deploy_cli_timeout"
  else if (/Build failed:/iu.test(plain)) category = "cloud_build_failed"
  else if (/Agent deployment failed/iu.test(plain))
    category = "deployment_rejected"
  else if (/Error checking deployment status/iu.test(plain))
    category = "deployment_status_read_failed"
  else if (/Deployment is degraded:/iu.test(plain))
    category = "deployment_degraded"
  else if (/Deployment did not become available/iu.test(plain))
    category = "deployment_unavailable"
  else if (/A problem occured during deployment/iu.test(plain))
    category = "deployment_request_failed"
  return {
    category,
    exitCode: Number.isInteger(code) ? code : null,
    ...(buildId ? { buildRef: safeRef(salt, buildId) } : {}),
  }
}

export async function reconcileProbeDeployment({ deploy, readManifest }) {
  const attempt = await deploy()
  try {
    return {
      state: await readManifest(attempt.buildId),
      diagnostic: { ...attempt.diagnostic, reconciled: true },
    }
  } catch {
    const error = new Error("probe_manifest_readback_failed")
    error.deployDiagnostic = { ...attempt.diagnostic, reconciled: false }
    throw error
  }
}

export function decodeClaims(token) {
  const parts = token?.split(".")
  if (!parts || parts.length < 2) throw new Error("daily_claims_invalid")
  const payload = JSON.parse(
    Buffer.from(parts[1], "base64url").toString("utf8")
  )
  const properties = payload.properties ?? payload
  return {
    expiresAtEpochSeconds: properties.exp,
    ejectAtTokenExpiry: properties.eject_at_token_exp,
    isOwner: properties.is_owner,
    roomScoped:
      typeof properties.room_name === "string" &&
      properties.room_name.length > 0,
  }
}

export function assertBoundedClaims(claims, expiresAt) {
  if (
    claims.expiresAtEpochSeconds !== expiresAt ||
    claims.ejectAtTokenExpiry !== true ||
    claims.isOwner !== false ||
    claims.roomScoped !== true
  )
    throw new Error("daily_claims_unbounded")
}

export function manifestFacts(value, imageDigest) {
  const body = value?.body
  const deployment = body?.deployment
  const spec = deployment?.manifest?.spec
  const secrets = spec?.envFromSecretNames ?? []
  if (!body || !deployment || !spec || !Array.isArray(secrets))
    throw new Error("manifest_shape_invalid")
  const duration =
    spec.maxSessionDurationSeconds ??
    deployment.maxSessionDurationSeconds ??
    deployment.maxSessionDuration ??
    body.maxSessionDurationSeconds ??
    body.maxSessionDuration
  return {
    agentName: body.name,
    buildId: deployment.buildId,
    deploymentId: deployment.deploymentId ?? deployment.id,
    imageDigest,
    minAgents: body.autoScaling?.minReplicas,
    maxAgents: body.autoScaling?.maxReplicas,
    secretSets: secrets,
    ...(duration == null ? {} : { maxSessionDurationSeconds: duration }),
  }
}

export function verifyBaseline(manifest, sessions, keys, secretSets) {
  const active = sessions.filter((session) => session.endedAt == null)
  const root = keys?.body ?? keys
  const privateKeys = Array.isArray(root?.private)
    ? root.private
    : (root?.apiKeys ?? root?.keys ?? []).filter(
        (key) => key.type === "private"
      )
  const sets = (secretSets?.body ?? secretSets)?.sets ?? []
  return (
    manifest.agentName === PROD_AGENT &&
    manifest.buildId === BASELINE.buildId &&
    manifest.imageDigest === BASELINE.imageDigest &&
    manifest.minAgents === BASELINE.minAgents &&
    manifest.maxAgents === BASELINE.maxAgents &&
    JSON.stringify(manifest.secretSets) ===
      JSON.stringify([BASELINE.secretSet]) &&
    !Object.hasOwn(manifest, "maxSessionDurationSeconds") &&
    active.length === 0 &&
    privateKeys.length === 0 &&
    !sets.some((set) => set.name === PROBE_AGENT)
  )
}

export function verifyProbeManifest(manifest, buildId) {
  return (
    manifest.agentName === PROBE_AGENT &&
    manifest.buildId === buildId &&
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(
      manifest.deploymentId
    ) &&
    /^sha256:[a-f0-9]{64}$/u.test(manifest.imageDigest) &&
    manifest.imageDigest !== BASELINE.imageDigest &&
    manifest.minAgents === 0 &&
    manifest.maxAgents === 1 &&
    manifest.secretSets.length === 0 &&
    manifest.maxSessionDurationSeconds === LIMITS.providerSeconds
  )
}

export function normalizeSessionObservation(session) {
  const metrics = session?.resourceMetrics
  const lastSample = Array.isArray(metrics?.timeseries)
    ? metrics.timeseries.at(-1)
    : null
  const rawState = String(
    session?.status ?? session?.state ?? "unknown"
  ).toLowerCase()
  const state = [...TERMINAL_STATES, "active", "starting", "pending"].includes(
    rawState
  )
    ? rawState
    : "unknown"
  const safeTimestamp = (value) =>
    typeof value === "string" && Number.isFinite(Date.parse(value))
      ? new Date(Date.parse(value)).toISOString()
      : null
  const providerStartedAt = safeTimestamp(
    session?.startedAt ?? session?.createdAt
  )
  const providerEndedAt = safeTimestamp(session?.endedAt)
  const terminal = providerEndedAt != null || TERMINAL_STATES.has(state)
  const start = Date.parse(providerStartedAt)
  const end = Date.parse(providerEndedAt)
  return {
    terminal,
    state,
    providerStartedAt,
    providerEndedAt,
    updatedAt: safeTimestamp(session?.updatedAt),
    metricSampleCount: Number.isSafeInteger(metrics?.sampleCount)
      ? metrics.sampleCount
      : null,
    lastMetricSampleAt: Number.isFinite(lastSample?.t) ? lastSample.t : null,
    observedRuntimeMinutes:
      Number.isFinite(start) && Number.isFinite(end) && end >= start
        ? (end - start) / 60_000
        : null,
    confirmedBilledMinutes: null,
    usageStatus: "unknown",
  }
}

export function stableUsageMarker(session) {
  const observation = normalizeSessionObservation(session)
  if (
    !observation.terminal ||
    !observation.metricSampleCount ||
    observation.lastMetricSampleAt == null
  )
    return null
  return JSON.stringify({
    providerEndedAt: observation.providerEndedAt,
    updatedAt: observation.updatedAt,
    metricSampleCount: observation.metricSampleCount,
    lastMetricSampleAt: observation.lastMetricSampleAt,
  })
}

export function isNotFoundStop(output) {
  return /(?:404|not found)/iu.test(output)
}

export function classifyStopCommandResult(result) {
  if (result.status === "timeout")
    return { status: "timeout", httpStatus: null, exitCode: result.exitCode }
  if (result.status === "network_failure")
    return { status: "network_failure", httpStatus: null, exitCode: null }
  if (result.exitCode === 0)
    return { status: "success", httpStatus: null, exitCode: 0 }
  const notFound = /(?:^|\D)404(?:\D|$)/u.test(result.output)
  const permission = /(?:401|403|unauthorized|forbidden|permission)/iu.test(
    result.output
  )
  return {
    status: notFound
      ? "http_error"
      : permission
        ? "permission_error"
        : "cli_failure",
    httpStatus: notFound ? 404 : null,
    exitCode: result.exitCode,
  }
}

export function applicationSessionIdentity(
  definition,
  operatorSessionId,
  registeredSessionId
) {
  return definition.discard ? (registeredSessionId ?? null) : operatorSessionId
}

export function acceptProbeCallback({
  raw,
  headers,
  expected,
  now = Date.now(),
}) {
  const timestamp = headers["x-provider-proof-timestamp"]
  const nonce = headers["x-provider-proof-nonce"]
  const signature = headers["x-provider-proof-signature"]
  if (
    !/^\d{10}$/u.test(timestamp ?? "") ||
    !/^[a-f0-9]{32}$/u.test(nonce ?? "")
  )
    throw new Error("callback_auth_invalid")
  if (Math.abs(now - Number(timestamp) * 1_000) > 30_000)
    throw new Error("callback_expired")
  const actual = Buffer.from(signature ?? "", "hex")
  const wanted = createHmac("sha256", expected.secret)
    .update(`${timestamp}.${nonce}.`)
    .update(raw)
    .digest()
  if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted))
    throw new Error("callback_auth_invalid")
  const body = JSON.parse(raw.toString("utf8"))
  if (
    body.runId !== expected.runId ||
    body.case !== expected.caseId ||
    body.bootId !== expected.bootId ||
    typeof body.sessionId !== "string" ||
    !["registered", "agent_joined", "agent_ejected"].includes(body.event)
  )
    throw new Error("callback_correlation_invalid")
  const observedAt = Number.isSafeInteger(body.observedAt)
    ? body.observedAt * 1_000
    : Date.parse(body.observedAt)
  if (!Number.isFinite(observedAt))
    throw new Error("callback_correlation_invalid")
  if (expected.sessionId && body.sessionId !== expected.sessionId)
    throw new Error("callback_session_mismatch")
  if (expected.expiresAtEpochSeconds != null)
    assertBoundedClaims(body.dailyClaims, expected.expiresAtEpochSeconds)
  return { ...body, sourceTimestamp: Number(timestamp) * 1_000, nonce }
}

function callbackIdentity(event) {
  const normalized = {
    runId: event.runId,
    case: event.case,
    bootId: event.bootId,
    sessionId: event.sessionId,
    event: event.event,
    observedAt: event.observedAt,
    dailyClaims: event.dailyClaims ?? null,
  }
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex")
}

async function runCommand(args, { timeoutMs = 10 * 60_000 } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(
      "uv",
      [
        "run",
        "--project",
        "agent",
        "--with",
        "pipecatcloud==0.6.0",
        "pipecat",
        ...args,
      ],
      {
        cwd: ROOT,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      }
    )
    let output = ""
    let timedOut = false
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (chunk) => {
        if (output.length < 32_000) output += chunk.toString("utf8")
      })
    const timer = setTimeout(() => {
      timedOut = true
      try {
        process.kill(-child.pid, "SIGTERM")
      } catch {}
      setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL")
        } catch {}
      }, 5_000).unref()
    }, timeoutMs)
    child.once("error", () => {
      clearTimeout(timer)
      resolvePromise({
        status: "network_failure",
        exitCode: null,
        output: "",
        timedOut,
      })
    })
    child.once("exit", (code) => {
      clearTimeout(timer)
      resolvePromise({
        status: timedOut ? "timeout" : code === 0 ? "success" : "cli_failure",
        exitCode: Number.isInteger(code) ? code : null,
        output,
        timedOut,
      })
    })
  })
}

async function requestJson(
  url,
  { token, method = "GET", body, timeoutMs = 30_000 }
) {
  let response
  try {
    const signals = [AbortSignal.timeout(timeoutMs)]
    if (exerciseSignal) signals.push(exerciseSignal)
    response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any(signals),
    })
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError")
      throw new Error("provider_timeout")
    throw new Error("provider_network_failure")
  }
  const text = await response.text()
  let value
  try {
    value = text ? JSON.parse(text) : null
  } catch {
    throw new Error("provider_response_invalid")
  }
  if (!response.ok) throw new Error(`provider_http_${response.status}`)
  return value
}

async function readControlPlane(operatorToken, organization, agentName) {
  const base = `${ORIGIN}/v1/organizations/${encodeURIComponent(organization)}`
  const service = await requestJson(`${base}/services/${agentName}`, {
    token: operatorToken,
  })
  const buildId = service?.body?.deployment?.buildId
  if (typeof buildId !== "string") throw new Error("manifest_build_missing")
  const buildValue = await requestJson(
    `${base}/builds/${encodeURIComponent(buildId)}`,
    { token: operatorToken }
  )
  const build = buildValue?.body?.build ?? buildValue?.build ?? buildValue
  const imageDigest = build?.imageDigest ?? build?.digest
  if (typeof imageDigest !== "string")
    throw new Error("manifest_digest_missing")
  const sessionValue = await requestJson(
    `${base}/services/${agentName}/sessions`,
    { token: operatorToken }
  )
  const sessions =
    sessionValue?.sessions ?? sessionValue?.body?.sessions ?? sessionValue
  if (!Array.isArray(sessions)) throw new Error("session_list_invalid")
  const keys = await requestJson(`${base}/apiKeys`, { token: operatorToken })
  const secretSets = await requestJson(`${base}/secrets`, {
    token: operatorToken,
  })
  return {
    base,
    manifest: manifestFacts(service, imageDigest),
    sessions,
    keys,
    secretSets,
  }
}

async function stopExact(organization, sessionId) {
  const result = await runCommand(
    [
      "cloud",
      "agent",
      "stop",
      PROBE_AGENT,
      "--session-id",
      sessionId,
      "--organization",
      organization,
      "--force",
    ],
    { timeoutMs: 60_000 }
  )
  return classifyStopCommandResult(result)
}

async function deployProbe(organization, salt) {
  const result = await runCommand([
    "cloud",
    "deploy",
    PROBE_AGENT,
    "--build-dir",
    PROBE_ROOT,
    "--dockerfile",
    "Dockerfile",
    "--min-agents",
    "0",
    "--max-agents",
    "1",
    "--profile",
    "agent-1x",
    "--max-session-duration",
    String(LIMITS.providerSeconds),
    "--organization",
    organization,
    "--no-credentials",
    "--force",
    "--yes",
  ])
  return {
    buildId: deployBuildId(result.output),
    diagnostic:
      result.exitCode === 0
        ? { category: "deploy_cli_success", exitCode: 0 }
        : deployFailureDiagnostic(result.output, {
            code: result.exitCode,
            timedOut: result.timedOut,
            salt,
          }),
  }
}

async function deleteProbe(organization) {
  const result = await runCommand([
    "cloud",
    "agent",
    "delete",
    PROBE_AGENT,
    "--organization",
    organization,
    "--force",
  ])
  return classifyStopCommandResult(result)
}

async function waitForManifest(
  operatorToken,
  organization,
  agentName,
  predicate,
  deadline
) {
  while (Date.now() < deadline) {
    const current = await readControlPlane(
      operatorToken,
      organization,
      agentName
    )
    if (predicate(current.manifest)) return current
    await delay(5_000)
  }
  throw new Error("manifest_readback_timeout")
}

async function probeAbsent(operatorToken, organization) {
  try {
    await readControlPlane(operatorToken, organization, PROBE_AGENT)
    return false
  } catch (error) {
    if (error?.message === "provider_http_404") return true
    throw error
  }
}

async function readSession(operatorToken, organization, sessionId) {
  const base = `${ORIGIN}/v1/organizations/${encodeURIComponent(organization)}`
  const value = await requestJson(`${base}/services/${PROBE_AGENT}/sessions`, {
    token: operatorToken,
  })
  const sessions = value?.sessions ?? value?.body?.sessions ?? value
  if (!Array.isArray(sessions)) throw new Error("session_list_invalid")
  return (
    sessions.find((item) => (item.sessionId ?? item.id) === sessionId) ?? null
  )
}

export async function startCollector({ store, scratch }) {
  const expected = new Map()
  const events = new Map()
  const logicalCallbacks = new Map()
  const bootSessions = new Map()
  let witness = null
  let fatalWrite = null
  const server = createServer(async (request, response) => {
    let persistenceAttempt = false
    try {
      if (fatalWrite) {
        persistenceAttempt = true
        throw fatalWrite
      }
      const url = new URL(request.url ?? "/", "http://127.0.0.1")
      if (
        request.method === "GET" &&
        witness &&
        url.pathname === witness.path
      ) {
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        })
        response.end(await readFile(witness.file))
        return
      }
      const chunks = []
      let size = 0
      for await (const chunk of request) {
        size += chunk.length
        if (size > 64 * 1024) throw new Error("callback_body_too_large")
        chunks.push(chunk)
      }
      const raw = Buffer.concat(chunks)
      if (
        request.method === "POST" &&
        witness &&
        url.pathname === witness.reportPath
      ) {
        if (request.headers.authorization !== `Bearer ${witness.secret}`)
          throw new Error("witness_auth")
        const body = JSON.parse(raw.toString("utf8"))
        if (
          body.case !== witness.caseId ||
          !["browser_joined", "browser_ejected"].includes(body.event)
        )
          throw new Error("witness_event")
        const observed = { ...body, observedAt: new Date().toISOString() }
        persistenceAttempt = true
        await store.append({
          kind: "witness_observation",
          source: "operator_witness",
          caseRef: body.case,
          payload: { event: body.event, observedAt: observed.observedAt },
        })
        events.set(`${body.case}:${body.event}`, observed)
        response.writeHead(204).end()
        return
      }
      const probe = [...expected.values()].find(
        (item) => item.path === url.pathname
      )
      if (request.method !== "POST" || !probe) throw new Error("callback_path")
      const event = acceptProbeCallback({
        raw,
        headers: request.headers,
        expected: probe,
      })
      const identity = callbackIdentity(event)
      const logicalKey = `${event.bootId}:${event.event}`
      const previous = logicalCallbacks.get(logicalKey)
      const previousSessionId = bootSessions.get(event.bootId)
      if (
        (previous && previous !== identity) ||
        (previousSessionId && previousSessionId !== event.sessionId)
      ) {
        const sessionRef = safeRef(store.recovery.salt, event.sessionId)
        persistenceAttempt = true
        await store.checkpoint((recovery) => {
          recovery.sessions[sessionRef] ??= {
            id: event.sessionId,
            caseRef: event.case,
            sources: ["conflicting_authenticated_callback"],
            stopAttempts: 0,
            stopHistory: [],
            usageStatus: "unknown",
            confirmedBilledMinutes: null,
            deadline: recovery.dispatches.find(
              (item) => item.caseRef === event.case
            )?.deadline,
          }
        })
        await store.append({
          kind: "session_identity",
          source: "conflicting_authenticated_callback",
          caseRef: event.case,
          payload: { sessionRef, conflict: true },
        })
        persistenceAttempt = false
        throw new Error("callback_conflict")
      }
      if (!previous) {
        const sessionRef = safeRef(store.recovery.salt, event.sessionId)
        const identitySource =
          event.event === "registered"
            ? "application_registration"
            : "probe_media_observation"
        persistenceAttempt = true
        await store.checkpoint((recovery) => {
          const session = recovery.sessions[sessionRef] ?? {
            id: event.sessionId,
            caseRef: event.case,
            sources: [],
            stopAttempts: 0,
            stopHistory: [],
            usageStatus: "unknown",
            confirmedBilledMinutes: null,
            deadline: recovery.dispatches.find(
              (item) => item.caseRef === event.case
            )?.deadline,
          }
          if (!session.sources.includes(identitySource))
            session.sources.push(identitySource)
          recovery.sessions[sessionRef] = session
          if (identitySource === "application_registration") {
            const dispatch = recovery.dispatches.find(
              (item) =>
                item.caseRef === event.case && item.outcome === "unknown"
            )
            if (dispatch) dispatch.outcome = "identity_recovered"
          }
        })
        await store.append({
          kind: "session_identity",
          source: identitySource,
          caseRef: event.case,
          payload: { sessionRef },
        })
        await store.append({
          kind: "callback",
          source: "authenticated_probe",
          caseRef: event.case,
          payload: {
            event: event.event,
            bootRef: safeRef(store.recovery.salt, event.bootId),
            sessionRef,
            sourceTimestamp: new Date(event.sourceTimestamp).toISOString(),
            sourceObservedAt: new Date(
              Number.isSafeInteger(event.observedAt)
                ? event.observedAt * 1_000
                : Date.parse(event.observedAt)
            ).toISOString(),
            dailyClaimsBounded:
              probe.expiresAtEpochSeconds == null ? null : true,
            callbackIdentity: identity,
          },
        })
        logicalCallbacks.set(logicalKey, identity)
        bootSessions.set(event.bootId, event.sessionId)
        events.set(`${event.case}:${event.event}`, event)
      }
      response.writeHead(204).end()
    } catch (error) {
      if (persistenceAttempt) {
        fatalWrite = new Error("callback_persist_failed")
        response.writeHead(503).end()
      } else if (error?.message === "callback_conflict")
        response.writeHead(409).end()
      else response.writeHead(401).end()
    }
  })
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolvePromise)
  })
  const port = server.address().port
  return {
    port,
    register(config) {
      expected.set(config.bootId, config)
    },
    bindSession(bootId, sessionId) {
      const config = expected.get(bootId)
      config.sessionId = sessionId
      for (const event of events.values())
        if (event.bootId === bootId && event.sessionId !== sessionId)
          throw new Error("callback_session_mismatch")
    },
    async wait(caseId, event, deadline) {
      const key = `${caseId}:${event}`
      while (Date.now() < deadline) {
        if (fatalWrite) throw fatalWrite
        if (events.has(key)) return events.get(key)
        await delay(100)
      }
      throw new Error(`${event}_timeout`)
    },
    has(caseId, event) {
      return events.has(`${caseId}:${event}`)
    },
    async openWitness({ caseId, dailyRoom, dailyToken }) {
      const nonce = randomBytes(24).toString("base64url")
      const secret = randomBytes(24).toString("base64url")
      const path = `/witness/${nonce}`
      const reportPath = `/witness-report/${nonce}`
      const file = join(scratch, "browser-witness.html")
      const html = `<!doctype html><meta charset="utf-8"><title>Provider proof witness</title><script src="https://unpkg.com/@daily-co/daily-js"></script><script>
const report=(event)=>fetch(${JSON.stringify(reportPath)},{method:"POST",headers:{"authorization":${JSON.stringify(`Bearer ${secret}`)},"content-type":"application/json"},body:JSON.stringify({case:${JSON.stringify(caseId)},event})});
const call=window.DailyIframe.createCallObject();call.on("joined-meeting",()=>report("browser_joined"));call.on("left-meeting",()=>report("browser_ejected"));call.join({url:${JSON.stringify(dailyRoom)},token:${JSON.stringify(dailyToken)}});</script>`
      const handle = await open(file, "wx", 0o600)
      try {
        await handle.writeFile(html)
      } finally {
        await handle.close()
      }
      witness = { caseId, path, reportPath, secret, file }
      await new Promise((resolvePromise, reject) => {
        const child = spawn("open", [`http://127.0.0.1:${port}${path}`], {
          stdio: "ignore",
        })
        child.once("error", reject)
        child.once("exit", (code) =>
          code === 0
            ? resolvePromise()
            : reject(new Error("browser_open_failed"))
        )
      })
    },
    close() {
      return new Promise((resolvePromise) => server.close(resolvePromise))
    },
  }
}

async function startTunnel(port) {
  const child = spawn(
    "ngrok",
    ["http", String(port), "--log=stdout", "--log-format=json"],
    {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    }
  )
  let exited = false
  child.once("exit", () => {
    exited = true
  })
  child.once("error", () => {
    exited = true
  })
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (exited) break
    try {
      const value = await requestJson("http://127.0.0.1:4040/api/tunnels", {
        token: "unused",
      })
      const url = value.tunnels?.find(
        (item) =>
          item.proto === "https" &&
          String(item.config?.addr ?? "").endsWith(`:${port}`)
      )?.public_url
      if (typeof url === "string" && url.startsWith("https://"))
        return {
          url,
          close() {
            try {
              process.kill(-child.pid, "SIGTERM")
            } catch {}
          },
        }
    } catch {}
    await delay(250)
  }
  try {
    process.kill(-child.pid, "SIGTERM")
  } catch {}
  throw new Error("tunnel_start_failed")
}

function cleanupDependencies({
  operatorToken,
  organization,
  signal = null,
  waitForUnknown = true,
}) {
  return {
    now: () => Date.now(),
    sleep: (milliseconds) => sleep(milliseconds, signal),
    readProbe: () => readControlPlane(operatorToken, organization, PROBE_AGENT),
    readProduction: () =>
      readControlPlane(operatorToken, organization, PROD_AGENT),
    readSession: (sessionId) =>
      readSession(operatorToken, organization, sessionId),
    stopSession: (sessionId) => stopExact(organization, sessionId),
    deleteProbe: () => deleteProbe(organization),
    probeAbsent: () => probeAbsent(operatorToken, organization),
    waitForUnknown,
  }
}

function assertOwnedProbe(recovery, state) {
  if (!state?.manifest) throw new Error("ownership_unresolved")
  if (
    state.manifest.agentName !== recovery.serviceName ||
    state.manifest.buildId !== recovery.probe?.buildId ||
    state.manifest.deploymentId !== recovery.probe?.deploymentId
  )
    throw new Error("ownership_mismatch")
}

async function recordOperation(
  store,
  { name, targetRef = null, caseRef = null, source = "operator", perform }
) {
  const operationRef = safeRef(store.recovery.salt, `${name}:${randomUUID()}`)
  await store.append({
    kind: "operation_intent",
    source,
    caseRef,
    operationRef,
    payload: { name, targetRef },
  })
  try {
    const result = await perform()
    await store.append({
      kind: "operation_result",
      source,
      caseRef,
      operationRef,
      payload: { name, targetRef, ...result },
    })
    return result
  } catch (error) {
    await store.append({
      kind: "operation_result",
      source,
      caseRef,
      operationRef,
      payload: {
        name,
        targetRef,
        status: "unknown",
        category: safeCategory(error),
      },
    })
    throw error
  }
}

export async function reconcileSession(store, sessionRef, dependencies) {
  const session = store.recovery.sessions[sessionRef]
  if (!session) throw new Error("session_status_unknown")
  const deadline = session.deadline
  let lastObservation = null
  while (dependencies.now() < deadline) {
    const raw = await dependencies.readSession(session.id)
    if (!raw) throw new Error("session_status_unknown")
    const observation = normalizeSessionObservation(raw)
    lastObservation = observation
    await store.append({
      kind: "session_status",
      source: "provider_readback",
      caseRef: session.caseRef,
      payload: { sessionRef, ...observation },
    })
    await store.checkpoint((recovery) =>
      Object.assign(recovery.sessions[sessionRef], observation)
    )
    if (observation.terminal) return observation
    if (session.stopAttempts >= 3) throw new Error("session_stop_exhausted")
    const spacing =
      session.stopAttempts === 0
        ? 0
        : session.stopAttempts === 1
          ? 5_000
          : 15_000
    const lastAttemptAt = session.lastStopAttemptAt ?? 0
    if (dependencies.now() < lastAttemptAt + spacing) {
      await dependencies.sleep(lastAttemptAt + spacing - dependencies.now())
      continue
    }
    const attempt = session.stopAttempts + 1
    await store.checkpoint((recovery) => {
      recovery.sessions[sessionRef].stopAttempts = attempt
      recovery.sessions[sessionRef].lastStopAttemptAt = dependencies.now()
    })
    const result = await recordOperation(store, {
      name: "stop_session",
      targetRef: sessionRef,
      caseRef: session.caseRef,
      source: session.sources.includes("application_registration")
        ? "application_recovery"
        : "operator_intervention",
      perform: () => dependencies.stopSession(session.id),
    })
    await store.checkpoint((recovery) =>
      recovery.sessions[sessionRef].stopHistory.push(result)
    )
    if (result.status === "permission_error")
      throw new Error("session_permission_denied")
    // A 404 is not a terminal observation. The next exact read must prove termination.
  }
  await store.append({
    kind: "resource_observation",
    source: "provider_readback",
    caseRef: session.caseRef,
    payload: { sessionRef, ...lastObservation, deadlineExceeded: true },
  })
  throw new Error("cleanup_deadline_exceeded")
}

export async function cleanupRun(store, dependencies) {
  if (store.truncatedTail) {
    if (store.recovery.firstFailure) {
      await store.append({
        kind: "cleanup_result",
        source: "recovery",
        payload: { check: "journal_truncated_tail", status: "blocked" },
      })
    } else await store.latchFailure({ category: "journal_truncated_tail" })
  }
  const cleanupErrors = []
  let ownedState = null
  let mutationBlocked = false
  for (const dispatch of store.recovery.dispatches ?? []) {
    if (
      dependencies.waitForUnknown !== false &&
      dispatch.outcome === "unknown" &&
      dependencies.now() < dispatch.deadline
    ) {
      await dependencies.sleep(dispatch.deadline - dependencies.now())
    }
  }
  try {
    const candidate = await dependencies.readProbe()
    assertOwnedProbe(store.recovery, candidate)
    ownedState = candidate
    await store.append({
      kind: "resource_observation",
      source: "provider_readback",
      payload: {
        resource: "probe_service",
        buildRef: safeRef(store.recovery.salt, ownedState.manifest.buildId),
        deploymentRef: safeRef(
          store.recovery.salt,
          ownedState.manifest.deploymentId
        ),
        activeSessionCount: ownedState.sessions.filter(
          (session) => session.endedAt == null
        ).length,
      },
    })
  } catch (error) {
    if (error?.message !== "provider_http_404") cleanupErrors.push(error)
    if (["ownership_mismatch", "ownership_unresolved"].includes(error?.message))
      mutationBlocked = true
  }

  if (ownedState) {
    for (const sessionRef of Object.keys(store.recovery.sessions)) {
      if (mutationBlocked) break
      try {
        await reconcileSession(store, sessionRef, dependencies)
      } catch (error) {
        cleanupErrors.push(error)
        if (error?.message === "session_permission_denied")
          mutationBlocked = true
      }
    }
    for (const dispatch of store.recovery.dispatches ?? [])
      if (dispatch.outcome === "unknown") {
        await store.append({
          kind: "resource_observation",
          source: "application_recovery",
          caseRef: dispatch.caseRef,
          payload: {
            dispatchRef: dispatch.dispatchRef,
            sessionRef: null,
            identityStatus: "unknown",
            deadlineExceeded: dependencies.now() > dispatch.deadline,
          },
        })
        cleanupErrors.push(new Error("session_status_unknown"))
      }
    if (!mutationBlocked) {
      try {
        const result = await recordOperation(store, {
          name: "delete_probe_service",
          targetRef: safeRef(
            store.recovery.salt,
            store.recovery.probe.deploymentId
          ),
          perform: dependencies.deleteProbe,
        })
        await store.checkpoint((recovery) => {
          recovery.cleanup.deleteProbe = result
        })
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
  }

  try {
    const absent = await dependencies.probeAbsent()
    await store.append({
      kind: "cleanup_result",
      source: "provider_readback",
      payload: {
        check: "probe_service_absent",
        status: absent ? "confirmed" : "failed",
      },
    })
    await store.checkpoint((recovery) => {
      recovery.cleanup.probeServiceAbsent = absent
    })
    if (!absent)
      cleanupErrors.push(new Error("probe_service_delete_unverified"))
  } catch (error) {
    cleanupErrors.push(error)
  }

  try {
    const production = await dependencies.readProduction()
    const unchanged = verifyBaseline(
      production.manifest,
      production.sessions,
      production.keys,
      production.secretSets
    )
    await store.append({
      kind: "cleanup_result",
      source: "provider_readback",
      payload: {
        check: "production_unchanged",
        status: unchanged ? "confirmed" : "failed",
      },
    })
    await store.checkpoint((recovery) => {
      recovery.cleanup.productionUnchanged = unchanged
    })
    if (!unchanged) cleanupErrors.push(new Error("baseline_cleanup_unverified"))
  } catch (error) {
    cleanupErrors.push(error)
  }

  const unresolvedSessions = Object.values(store.recovery.sessions).filter(
    (session) => !session.terminal
  ).length
  await store.checkpoint((recovery) => {
    recovery.cleanup.unresolvedSessions = unresolvedSessions
    recovery.cleanup.completed =
      cleanupErrors.length === 0 &&
      unresolvedSessions === 0 &&
      recovery.cleanup.probeServiceAbsent === true &&
      recovery.cleanup.productionUnchanged === true
  })
  await store.append({
    kind: "cleanup_result",
    source: "operator",
    payload: {
      check: "containment",
      status: store.recovery.cleanup.completed ? "confirmed" : "blocked",
      unresolvedSessions,
      errorCategories: [...new Set(cleanupErrors.map(safeCategory))],
    },
  })
  return store.recovery.cleanup.completed
}

async function containFromMemory(store, dependencies) {
  let state
  try {
    state = await dependencies.readProbe()
    assertOwnedProbe(store.recovery, state)
  } catch {
    return false
  }
  for (const session of Object.values(store.recovery.sessions)) {
    try {
      const current = await dependencies.readSession(session.id)
      if (current && !normalizeSessionObservation(current).terminal) {
        const result = await dependencies.stopSession(session.id)
        if (result.status === "permission_error") return false
      }
    } catch {}
  }
  try {
    await dependencies.deleteProbe()
    return true
  } catch {
    return false
  }
}

async function runLive(runDir) {
  if (process.env.PROVIDER_PROOF_LIVE_RELEASE !== LIVE_RELEASE)
    throw new Error("live_release_missing")
  const runId = process.env.PROVIDER_PROOF_RUN_ID
  const publicKey = process.env.PIPECAT_API_KEY
  const operatorToken = process.env.PIPECAT_OPERATOR_TOKEN
  const organization = process.env.PIPECAT_ORGANIZATION
  if (![runId, publicKey, operatorToken, organization, runDir].every(Boolean))
    throw new Error("live_prerequisite_missing")

  const store = await DurableRunStore.create(runDir, { runId, organization })
  const scratch = join(store.runDir, ".runtime")
  await mkdir(scratch, { mode: 0o700 })
  let collector = null
  let tunnel = null
  let currentCase = null
  let currentOperation = null
  let secondSignal = false
  let evidenceWritable = true
  const controller = new AbortController()
  const cleanupController = new AbortController()
  exerciseSignal = controller.signal
  const onSignal = () => {
    if (controller.signal.aborted) {
      secondSignal = true
      cleanupController.abort()
      return
    }
    controller.abort()
  }
  process.on("SIGINT", onSignal)
  process.on("SIGTERM", onSignal)

  try {
    const preflight = await readControlPlane(
      operatorToken,
      organization,
      PROD_AGENT
    )
    if (
      !verifyBaseline(
        preflight.manifest,
        preflight.sessions,
        preflight.keys,
        preflight.secretSets
      )
    )
      throw new Error("baseline_preflight_failed")
    if (!(await probeAbsent(operatorToken, organization)))
      throw new Error("probe_service_already_exists")
    collector = await startCollector({ store, scratch })
    tunnel = await startTunnel(collector.port)
    currentOperation = "deploy_probe"
    const deployRef = safeRef(store.recovery.salt, "deploy_probe")
    await store.append({
      kind: "operation_intent",
      source: "operator",
      operationRef: deployRef,
      payload: { name: "deploy_probe" },
    })
    const reconciled = await reconcileProbeDeployment({
      deploy: () => deployProbe(organization, store.recovery.salt),
      readManifest: (buildId) =>
        waitForManifest(
          operatorToken,
          organization,
          PROBE_AGENT,
          (manifest) => verifyProbeManifest(manifest, buildId),
          Date.now() + 120_000
        ),
    })
    await store.checkpoint((recovery) => {
      recovery.probe = {
        buildId: reconciled.state.manifest.buildId,
        deploymentId: reconciled.state.manifest.deploymentId,
      }
    })
    await store.append({
      kind: "operation_result",
      source: "operator",
      operationRef: deployRef,
      payload: { name: "deploy_probe", ...reconciled.diagnostic },
    })

    for (const definition of CASES) {
      currentCase = definition.id
      if (store.recovery.starts >= LIMITS.starts)
        throw new Error("start_limit_exceeded")
      const dispatchedAt = Date.now()
      const deadline = dispatchedAt + LIMITS.caseSeconds * 1_000
      const expiresAt = Math.floor(dispatchedAt / 1_000) + 300
      const bootId = randomUUID()
      const callbackSecret = randomBytes(32).toString("base64url")
      const callbackPath = `/probe/${runId}/${definition.id}/${bootId}`
      const dispatchRef = safeRef(store.recovery.salt, bootId)
      collector.register({
        runId,
        caseId: definition.id,
        bootId,
        path: callbackPath,
        secret: Buffer.from(callbackSecret, "base64url"),
        expiresAtEpochSeconds: expiresAt,
      })
      await store.checkpoint((recovery) => {
        recovery.starts += 1
        recovery.dispatches.push({
          dispatchRef,
          caseRef: definition.id,
          dispatchedAt,
          deadline,
          providerDeadline: dispatchedAt + LIMITS.providerSeconds * 1_000,
          expiresAtEpochSeconds: expiresAt,
          providerLifetimeStart: "local_dispatch_pending_provider_timestamp",
          outcome: "unknown",
        })
      })
      currentOperation = "start_session"
      await store.append({
        kind: "operation_intent",
        source: "application",
        caseRef: definition.id,
        operationRef: dispatchRef,
        payload: {
          name: "start_session",
          deadline: new Date(deadline).toISOString(),
        },
      })
      let operatorResponse
      try {
        operatorResponse = await requestJson(
          `${ORIGIN}/v1/public/${PROBE_AGENT}/start`,
          {
            token: publicKey,
            method: "POST",
            timeoutMs: 120_000,
            body: {
              createDailyRoom: true,
              transport: "daily",
              dailyRoomProperties: { exp: expiresAt, eject_at_room_exp: true },
              dailyMeetingTokenProperties: {
                exp: expiresAt,
                eject_at_token_exp: true,
                is_owner: false,
              },
              body: {
                providerProof: {
                  case: definition.id,
                  runId,
                  bootId,
                  callbackUrl: `${tunnel.url}${callbackPath}`,
                  callbackSecret,
                },
              },
            },
          }
        )
      } catch (error) {
        await store.append({
          kind: "operation_result",
          source: "application",
          caseRef: definition.id,
          operationRef: dispatchRef,
          payload: {
            name: "start_session",
            status: "unknown",
            category: safeCategory(error),
          },
        })
        throw new Error("ambiguous_start_no_retry")
      }
      if (
        ![
          operatorResponse?.sessionId,
          operatorResponse?.dailyRoom,
          operatorResponse?.dailyToken,
        ].every((value) => typeof value === "string")
      )
        throw new Error("start_response_invalid")
      assertBoundedClaims(decodeClaims(operatorResponse.dailyToken), expiresAt)
      const sessionRef = safeRef(
        store.recovery.salt,
        operatorResponse.sessionId
      )
      await store.checkpoint((recovery) => {
        recovery.dispatches.find(
          (item) => item.dispatchRef === dispatchRef
        ).outcome = "accepted"
        const session = recovery.sessions[sessionRef] ?? {
          id: operatorResponse.sessionId,
          caseRef: definition.id,
          sources: [],
          stopAttempts: 0,
          stopHistory: [],
          usageStatus: "unknown",
          confirmedBilledMinutes: null,
          deadline,
        }
        if (!session.sources.includes("operator_start_response"))
          session.sources.push("operator_start_response")
        recovery.sessions[sessionRef] = session
      })
      await store.append({
        kind: "session_identity",
        source: "operator_start_response",
        caseRef: definition.id,
        operationRef: dispatchRef,
        payload: { sessionRef, applicationVisible: !definition.discard },
      })
      await store.append({
        kind: "operation_result",
        source: "application",
        caseRef: definition.id,
        operationRef: dispatchRef,
        payload: {
          name: "start_session",
          status: definition.discard ? "lost_response" : "success",
          sessionRef: definition.discard ? null : sessionRef,
          browserClaimsBounded: true,
        },
      })
      if (!definition.discard)
        collector.bindSession(bootId, operatorResponse.sessionId)

      let registered = null
      if (definition.id !== "no_registration_startup") {
        registered = await collector.wait(definition.id, "registered", deadline)
        if (registered.sessionId !== operatorResponse.sessionId)
          throw new Error("registration_session_mismatch")
      }
      const applicationSessionId = applicationSessionIdentity(
        definition,
        operatorResponse.sessionId,
        registered?.sessionId
      )
      if (
        definition.discard &&
        definition.id === "no_registration_startup" &&
        collector.has(definition.id, "registered")
      )
        throw new Error("unexpected_registration")
      if (definition.join) {
        await collector.openWitness({
          caseId: definition.id,
          dailyRoom: operatorResponse.dailyRoom,
          dailyToken: operatorResponse.dailyToken,
        })
        await collector.wait(definition.id, "browser_joined", deadline)
        const joined = await collector.wait(
          definition.id,
          "agent_joined",
          deadline
        )
        if (joined.sessionId !== operatorResponse.sessionId)
          throw new Error("agent_join_session_mismatch")
        assertBoundedClaims(joined.dailyClaims, expiresAt)
      }
      if (definition.stop === "ceiling") {
        await collector.wait(definition.id, "browser_ejected", deadline)
        const ejected = await collector.wait(
          definition.id,
          "agent_ejected",
          deadline
        )
        if (ejected.sessionId !== operatorResponse.sessionId)
          throw new Error("agent_ejection_session_mismatch")
      } else if (applicationSessionId) {
        const cleanupRef = safeRef(store.recovery.salt, applicationSessionId)
        await reconcileSession(
          store,
          cleanupRef,
          cleanupDependencies({ operatorToken, organization })
        )
        if (definition.stop === "twice")
          await recordOperation(store, {
            name: "repeat_stop_session",
            targetRef: cleanupRef,
            caseRef: definition.id,
            perform: () => stopExact(organization, applicationSessionId),
          })
      }
      await store.append({
        kind: "verdict",
        source: "operator",
        caseRef: definition.id,
        payload: {
          status: "partial",
          reason: "case_observations_complete_usage_unknown",
        },
      })
    }
  } catch (error) {
    try {
      await store.latchFailure({
        caseRef: currentCase,
        operationRef: currentOperation,
        category: safeCategory(error),
        predicate: String(error?.message ?? "operation_failed"),
      })
    } catch {
      evidenceWritable = false
    }
  } finally {
    exerciseSignal = null
  }

  if (!secondSignal) {
    const dependencies = cleanupDependencies({
      operatorToken,
      organization,
      signal: cleanupController.signal,
      waitForUnknown: !controller.signal.aborted,
    })
    try {
      await cleanupRun(store, dependencies)
    } catch (error) {
      evidenceWritable = false
      if (!secondSignal) await containFromMemory(store, dependencies)
      try {
        await store.latchFailure({ category: safeCategory(error) })
      } catch {}
    }
  }
  tunnel?.close()
  await collector?.close()
  await rm(scratch, { recursive: true, force: true })
  const before = projectSummary(store.records, store.recovery)
  const status =
    store.recovery.cleanup.completed === true &&
    !store.recovery.firstFailure &&
    before.usageStatus === "confirmed"
      ? "pass"
      : "blocked"
  const reason = secondSignal
    ? "cleanup_interrupted_recovery_required"
    : (store.recovery.firstFailure?.category ??
      (before.usageStatus !== "confirmed"
        ? "usage_unknown"
        : "cleanup_unverified"))
  let summary = { status: "blocked" }
  if (evidenceWritable) {
    try {
      await store.append({
        kind: "verdict",
        source: "operator",
        payload: { status, reason },
      })
      summary = await store.writeSummary()
    } catch {
      evidenceWritable = false
    }
  }
  process.removeListener("SIGINT", onSignal)
  process.removeListener("SIGTERM", onSignal)
  await store.close()
  process.stdout.write(
    `${JSON.stringify({ status, reason, runDir: store.runDir })}\n`
  )
  process.exitCode = summary.status === "pass" ? 0 : 1
}

async function recover(runDir) {
  const operatorToken = process.env.PIPECAT_OPERATOR_TOKEN
  const organization = process.env.PIPECAT_ORGANIZATION
  if (![operatorToken, organization, runDir].every(Boolean))
    throw new Error("recover_prerequisite_missing")
  const store = await DurableRunStore.open(runDir)
  try {
    if (store.recovery.organization !== organization) {
      await store.latchFailure({
        category: "ownership_mismatch",
        predicate: "recovery_organization_mismatch",
      })
      await store.append({
        kind: "cleanup_result",
        source: "recovery",
        payload: {
          check: "containment",
          status: "blocked",
          unresolvedSessions: Object.keys(store.recovery.sessions).length,
          errorCategories: ["ownership_mismatch"],
        },
      })
      await store.append({
        kind: "verdict",
        source: "recovery",
        payload: { status: "blocked", reason: "ownership_mismatch" },
      })
      await store.writeSummary()
      process.stdout.write(
        `${JSON.stringify({ status: "blocked", reason: "ownership_mismatch", runDir: store.runDir })}\n`
      )
      process.exitCode = 1
      return
    }
    const completed = await cleanupRun(
      store,
      cleanupDependencies({ operatorToken, organization })
    )
    const before = projectSummary(
      store.records,
      store.recovery,
      store.truncatedTail
    )
    const status =
      completed &&
      !store.recovery.firstFailure &&
      before.usageStatus === "confirmed"
        ? "pass"
        : "blocked"
    const reason =
      store.recovery.firstFailure?.category ??
      (before.usageStatus !== "confirmed"
        ? "usage_unknown"
        : "cleanup_unverified")
    await store.append({
      kind: "verdict",
      source: "recovery",
      payload: { status, reason },
    })
    await store.writeSummary()
    process.stdout.write(
      `${JSON.stringify({ status, reason, runDir: store.runDir })}\n`
    )
    process.exitCode = status === "pass" ? 0 : 1
  } finally {
    await store.close()
  }
}

function parseRunDir(argv) {
  const index = argv.indexOf("--run-dir")
  return index >= 0 ? argv[index + 1] : null
}

async function main() {
  const command = process.argv[2]
  if (command === "plan") {
    process.stdout.write(
      `${JSON.stringify({
        agent: PROBE_AGENT,
        productionAgent: PROD_AGENT,
        baseline: BASELINE,
        limits: LIMITS,
        cases: CASES,
      })}\n`
    )
    return
  }
  const runDir = parseRunDir(process.argv.slice(3))
  if (command === "live") return runLive(runDir)
  if (command === "recover") return recover(runDir)
  throw new Error(
    "usage: run.mjs plan|live --run-dir PATH|recover --run-dir PATH"
  )
}

if (import.meta.url === `file://${process.argv[1]}`)
  main().catch(() => {
    process.stderr.write("provider proof failed before durable result\n")
    process.exitCode = 1
  })
