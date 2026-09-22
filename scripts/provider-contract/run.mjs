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
    if (signal?.aborted) {
      reject(new Error("operator_signal"))
      return
    }
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
      "callback_conflict",
      "callback_timeout",
      "daily_claims_invalid",
      "start_response_invalid",
      "billing_limit_exceeded",
      "reservation_limit_exceeded",
      "session_resource_incomplete",
      "session_resource_bound_exceeded",
      "active_sessions_unresolved",
      "session_identity_mismatch",
      "session_scope_mismatch",
      "private_key_missing",
      "private_key_inventory_invalid",
      "provider_timeout",
      "provider_network_failure",
      "session_stop_unverified",
      "repeat_stop_unverified",
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

function assertNotAborted(signal) {
  if (signal?.aborted) throw new Error("operator_signal")
}

function permissionFailure(error) {
  return [
    "provider_http_401",
    "provider_http_403",
    "session_permission_denied",
  ].includes(error?.message)
}

function isUuid(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
      value
    )
  )
}

function mutationBlocked(recovery) {
  return (
    recovery.mutationBlocked === true ||
    Object.values(recovery.sessions).some((session) =>
      session.stopHistory?.some(
        (result) =>
          result.status === "permission_error" ||
          [401, 403].includes(result.httpStatus)
      )
    )
  )
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
    Object.entries(recovery.sessions ?? {}).every(
      ([sessionRef, session]) =>
        session.usageStatus === "confirmed" &&
        Number.isFinite(session.confirmedBilledMinutes) &&
        session.confirmedBilledMinutes >= 0 &&
        records.some(
          (record) =>
            record.kind === "resource_observation" &&
            record.payload.resource === "authoritative_usage" &&
            record.payload.sessionRef === sessionRef &&
            record.payload.usageStatus === "confirmed" &&
            record.payload.confirmedBilledMinutes ===
              session.confirmedBilledMinutes
        )
    ) &&
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
        record.payload.httpStatus === 200 &&
        sessionRefs.has(record.payload.sessionRef)
    )
    const hasResources = observed.some(
      (record) =>
        record.kind === "resource_observation" &&
        record.payload.resource === "session_resources" &&
        sessionRefs.has(record.payload.sessionRef) &&
        resourceEvidenceComplete(record.payload) &&
        record.payload.observedRuntimeMinutes <= LIMITS.providerSeconds / 60
    )
    const zeroActive = observed.some(
      (record) =>
        record.kind === "resource_observation" &&
        record.payload.resource === "probe_sessions" &&
        record.payload.complete === true &&
        record.payload.activeSessionCount === 0
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
          record.payload.name === "stop_session" &&
          record.payload.status === "success" &&
          record.payload.httpStatus === 200 &&
          sessionRefs.has(record.payload.targetRef)
      )
    const repeatCorrect =
      definition.stop !== "twice" ||
      observed.some(
        (record) =>
          record.kind === "operation_result" &&
          record.payload.name === "repeat_stop_session" &&
          sessionRefs.has(record.payload.targetRef) &&
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
      hasResources &&
      zeroActive &&
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
    recovery.cleanup.zeroActiveComplete === true &&
    sessions.every(resourceEvidenceComplete) &&
    unresolvedDispatches(recovery).length === 0 &&
    recovery.starts === CASES.length &&
    recovery.reservedSessionMinutes ===
      (CASES.length * LIMITS.caseSeconds) / 60 &&
    recovery.dispatches?.length === CASES.length &&
    recovery.dispatches.every(
      (dispatch) =>
        dispatch.reservedMinutes === LIMITS.caseSeconds / 60 &&
        dispatch.outcome !== "unknown"
    ) &&
    !firstFailure &&
    !recovery.firstFailure &&
    !records.some(
      (record) => record.kind === "session_identity" && record.payload.conflict
    ) &&
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
    resourceStatus: status,
    accountingStatus: usageConfirmed ? "confirmed" : "unknown",
    reservedSessionMinutes:
      recovery.reservedSessionMinutes ??
      ((recovery.starts ?? 0) * LIMITS.caseSeconds) / 60,
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
      reservedSessionMinutes: 0,
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
    const guardPath = join(absolute, "writer.takeover")
    try {
      await mkdir(guardPath, { mode: 0o700 })
    } catch (error) {
      if (error.code === "EEXIST") throw new Error("run_writer_active")
      throw error
    }
    let lockHandle
    try {
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
      lockHandle = await open(lockPath, "wx", 0o600)
      await lockHandle.writeFile(`${JSON.stringify({ pid: process.pid })}\n`)
      await lockHandle.sync()
    } finally {
      await rm(guardPath, { recursive: true })
    }
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
      await new DurableRunStore(absolute, null, [], lockHandle).close()
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
    category = safeCategory({ message: category })
    if (
      ![
        "registered",
        "deploy_probe",
        "start_session",
        "run_preflight",
        "recovery_cleanup",
        "recovery_organization_mismatch",
        "callback_identity_consistency",
      ].includes(predicate)
    )
      predicate = null
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
    const owned = await this.lockHandle.stat()
    const lockPath = join(this.runDir, "writer.lock")
    try {
      const current = await lstat(lockPath)
      if (current.ino === owned.ino && current.dev === owned.dev)
        await rm(lockPath)
    } catch (error) {
      if (error.code !== "ENOENT") throw error
    } finally {
      await this.lockHandle.close()
    }
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
  let payload
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))
    if (!payload || typeof payload !== "object") throw new Error()
  } catch {
    throw new Error("daily_claims_invalid")
  }
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
    serviceId: deployment.serviceId,
    buildId: deployment.buildId,
    deploymentId: deployment.deploymentId ?? deployment.id,
    imageDigest,
    minAgents: body.autoScaling?.minReplicas,
    maxAgents: body.autoScaling?.maxReplicas,
    secretSets: secrets,
    ...(duration == null ? {} : { maxSessionDurationSeconds: duration }),
  }
}

export function privateKeyInventory(keys) {
  const entries = (keys?.body ?? keys)?.private
  if (!Array.isArray(entries)) throw new Error("private_key_inventory_invalid")
  const ids = entries.map((entry) => {
    if (
      entry?.type !== "private" ||
      typeof entry.id !== "string" ||
      entry.id.trim().length === 0 ||
      entry.id.length > 512
    )
      throw new Error("private_key_inventory_invalid")
    return entry.id
  })
  if (new Set(ids).size !== ids.length)
    throw new Error("private_key_inventory_invalid")
  return ids.sort()
}

export function verifyBaseline(
  manifest,
  sessions,
  keys,
  secretSets,
  expectedPrivateKeyIds = []
) {
  const active = sessions.filter((session) => session.endedAt == null)
  let privateKeys
  try {
    privateKeys = privateKeyInventory(keys)
  } catch {
    return false
  }
  if (!Array.isArray(expectedPrivateKeyIds)) return false
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
    JSON.stringify(privateKeys) ===
      JSON.stringify([...expectedPrivateKeyIds].sort()) &&
    !sets.some((set) => set.name === PROBE_AGENT)
  )
}

export function verifyProbeManifest(manifest, buildId) {
  return (
    isUuid(manifest.serviceId) &&
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
    lastCpuMillicores:
      Number.isFinite(lastSample?.c) && lastSample.c >= 0 ? lastSample.c : null,
    lastMemoryBytes:
      Number.isFinite(lastSample?.m) && lastSample.m >= 0 ? lastSample.m : null,
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
  if (result.status === "interrupted")
    return {
      status: "interrupted",
      httpStatus: null,
      exitCode: result.exitCode,
    }
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

async function runCommand(
  args,
  { timeoutMs = 10 * 60_000, signal = exerciseSignal } = {}
) {
  assertNotAborted(signal)
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
    let killTimer
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (chunk) => {
        if (output.length < 32_000) output += chunk.toString("utf8")
      })
    const terminate = () => {
      try {
        process.kill(-child.pid, "SIGTERM")
      } catch {}
      killTimer ??= setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL")
        } catch {}
      }, 5_000).unref()
    }
    const onAbort = () => terminate()
    signal?.addEventListener("abort", onAbort, { once: true })
    const timer = setTimeout(() => {
      timedOut = true
      terminate()
    }, timeoutMs)
    child.once("error", () => {
      clearTimeout(timer)
      clearTimeout(killTimer)
      signal?.removeEventListener("abort", onAbort)
      resolvePromise({
        status: "network_failure",
        exitCode: null,
        output: "",
        timedOut,
      })
    })
    child.once("exit", (code) => {
      clearTimeout(timer)
      clearTimeout(killTimer)
      signal?.removeEventListener("abort", onAbort)
      resolvePromise({
        status: signal?.aborted
          ? "interrupted"
          : timedOut
            ? "timeout"
            : code === 0
              ? "success"
              : "cli_failure",
        exitCode: Number.isInteger(code) ? code : null,
        output,
        timedOut,
      })
    })
  })
}

async function requestJson(
  url,
  {
    token,
    method = "GET",
    body,
    timeoutMs = 30_000,
    signal = exerciseSignal,
    returnResponse = false,
  }
) {
  assertNotAborted(signal)
  let response
  try {
    const signals = [AbortSignal.timeout(timeoutMs)]
    if (signal) signals.push(signal)
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
    assertNotAborted(signal)
    if (error?.name === "TimeoutError" || error?.name === "AbortError")
      throw new Error("provider_timeout")
    throw new Error("provider_network_failure")
  }
  if (!response.ok) {
    if (returnResponse) return { httpStatus: response.status, value: null }
    throw Object.assign(new Error(`provider_http_${response.status}`), {
      httpStatus: response.status,
    })
  }
  const text = await response.text()
  let value
  try {
    value = text ? JSON.parse(text) : null
  } catch {
    if (returnResponse) return { httpStatus: response.status, value: null }
    throw Object.assign(new Error("provider_response_invalid"), {
      httpStatus: response.status,
    })
  }
  return returnResponse ? { httpStatus: response.status, value } : value
}

async function readControlPlane(
  operatorToken,
  organization,
  agentName,
  signal = exerciseSignal
) {
  const base = `${ORIGIN}/v1/organizations/${encodeURIComponent(organization)}`
  const service = await requestJson(`${base}/services/${agentName}`, {
    token: operatorToken,
    signal,
  })
  const buildId = service?.body?.deployment?.buildId
  if (typeof buildId !== "string") throw new Error("manifest_build_missing")
  const buildValue = await requestJson(
    `${base}/builds/${encodeURIComponent(buildId)}`,
    { token: operatorToken, signal }
  )
  const build = buildValue?.body?.build ?? buildValue?.build ?? buildValue
  const imageDigest = build?.imageDigest ?? build?.digest
  if (typeof imageDigest !== "string")
    throw new Error("manifest_digest_missing")
  const sessionValue = await requestJson(
    `${base}/services/${agentName}/sessions`,
    { token: operatorToken, signal }
  )
  const sessions =
    sessionValue?.sessions ?? sessionValue?.body?.sessions ?? sessionValue
  if (!Array.isArray(sessions)) throw new Error("session_list_invalid")
  const keys = await requestJson(`${base}/apiKeys`, {
    token: operatorToken,
    signal,
  })
  const secretSets = await requestJson(`${base}/secrets`, {
    token: operatorToken,
    signal,
  })
  return {
    base,
    manifest: manifestFacts(service, imageDigest),
    sessions,
    keys,
    secretSets,
  }
}

function privateSessionUrl(privateKey, recovery, sessionId) {
  if (!privateKey) throw new Error("private_key_missing")
  if (
    recovery.serviceName !== PROBE_AGENT ||
    !isUuid(recovery.probe?.serviceId) ||
    !isUuid(recovery.probe?.deploymentId) ||
    !isUuid(recovery.organization)
  )
    throw new Error("ownership_unresolved")
  return `${ORIGIN}/v1/agents/${encodeURIComponent(recovery.serviceName)}/sessions${sessionId == null ? "" : `/${encodeURIComponent(sessionId)}`}`
}

export async function readExactSession({
  privateKey,
  recovery,
  sessionId,
  signal,
}) {
  const url = privateSessionUrl(privateKey, recovery, sessionId)
  const { value, httpStatus } = await requestJson(url, {
    token: privateKey,
    signal,
    returnResponse: true,
  })
  const fail = (category) => {
    throw Object.assign(new Error(category), { httpStatus })
  }
  if (httpStatus !== 200) fail(`provider_http_${httpStatus}`)
  if (
    !value ||
    value.sessionId !== sessionId ||
    (value.resourceMetrics != null &&
      value.resourceMetrics.sessionId !== sessionId)
  )
    fail("session_identity_mismatch")
  if (
    value.serviceId !== recovery.probe.serviceId ||
    value.organizationId !== recovery.organization ||
    value.deploymentId !== recovery.probe.deploymentId
  )
    fail("session_scope_mismatch")
  return { ...value, httpStatus }
}

export async function stopExactSession({
  privateKey,
  recovery,
  sessionId,
  signal,
}) {
  const url = privateSessionUrl(privateKey, recovery, sessionId)
  try {
    const { value, httpStatus } = await requestJson(url, {
      token: privateKey,
      method: "DELETE",
      signal,
      timeoutMs: 60_000,
      returnResponse: true,
    })
    if ([401, 403].includes(httpStatus))
      return { status: "permission_error", httpStatus }
    if (httpStatus !== 200) return { status: "http_error", httpStatus }
    if (value?.session_id !== sessionId || value.status !== "terminated")
      return {
        status: "invalid_response",
        httpStatus,
        category: "session_identity_mismatch",
      }
    // A successful DELETE acknowledges the request; only an exact GET proves terminal resources.
    return { status: "success", httpStatus }
  } catch (error) {
    return {
      status: signal?.aborted
        ? "interrupted"
        : error.message === "provider_timeout"
          ? "timeout"
          : "network_failure",
      httpStatus: null,
    }
  }
}

export async function readActiveSessions({ privateKey, recovery, signal }) {
  const url = new URL(privateSessionUrl(privateKey, recovery))
  url.searchParams.set("status", "active")
  url.searchParams.set("deploymentId", recovery.probe.deploymentId)
  url.searchParams.set("offset", "0")
  const { value, httpStatus } = await requestJson(url.href, {
    token: privateKey,
    signal,
    returnResponse: true,
  })
  if (httpStatus !== 200)
    throw Object.assign(new Error(`provider_http_${httpStatus}`), {
      httpStatus,
    })
  const complete =
    Number.isSafeInteger(value?.total_count) &&
    value.total_count === 0 &&
    Array.isArray(value.sessions) &&
    value.sessions.length === 0
  return { complete, activeSessionCount: complete ? 0 : null, httpStatus }
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

async function deleteProbe(organization, signal = exerciseSignal) {
  const result = await runCommand(
    [
      "cloud",
      "agent",
      "delete",
      PROBE_AGENT,
      "--organization",
      organization,
      "--force",
    ],
    { timeoutMs: 60_000, signal }
  )
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

async function probeAbsent(
  operatorToken,
  organization,
  signal = exerciseSignal
) {
  try {
    await readControlPlane(operatorToken, organization, PROBE_AGENT, signal)
    return false
  } catch (error) {
    if (error?.message === "provider_http_404") return true
    throw error
  }
}

export async function startCollector({ store, scratch }) {
  const expected = new Map()
  const events = new Map()
  const logicalCallbacks = new Map()
  const bootSessions = new Map()
  let witness = null
  let fatalWrite = null
  let callbackQueue = Promise.resolve()
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
          "permissions-policy": "camera=(), microphone=()",
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
        expected: { ...probe, sessionId: undefined },
      })
      const pending = callbackQueue.then(async () => {
        if (fatalWrite) {
          persistenceAttempt = true
          throw fatalWrite
        }
        const identity = callbackIdentity(event)
        const logicalKey = `${event.bootId}:${event.event}`
        const previous = logicalCallbacks.get(logicalKey)
        const previousSessionId = bootSessions.get(event.bootId)
        if (
          (previous && previous !== identity) ||
          (previousSessionId && previousSessionId !== event.sessionId) ||
          (probe.sessionId && probe.sessionId !== event.sessionId)
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
          await store.latchFailure({
            category: "callback_conflict",
            caseRef: event.case,
            predicate: "callback_identity_consistency",
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
      })
      callbackQueue = pending.catch(() => {
        if (persistenceAttempt)
          fatalWrite = new Error("callback_persist_failed")
      })
      await pending
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
        if (store.recovery.firstFailure)
          throw new Error(store.recovery.firstFailure.category)
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
      const file = join(scratch, `browser-witness-${nonce}.html`)
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
  privateKey,
  recovery,
  signal = null,
  waitForUnknown = true,
}) {
  return {
    now: () => Date.now(),
    signal,
    sleep: (milliseconds) => sleep(milliseconds, signal),
    readProbe: () =>
      readControlPlane(operatorToken, organization, PROBE_AGENT, signal),
    readProduction: () =>
      readControlPlane(operatorToken, organization, PROD_AGENT, signal),
    readSession: (sessionId) =>
      readExactSession({ privateKey, recovery, sessionId, signal }),
    stopSession: (sessionId) =>
      stopExactSession({ privateKey, recovery, sessionId, signal }),
    readActiveSessions: () =>
      readActiveSessions({ privateKey, recovery, signal }),
    deleteProbe: () => deleteProbe(organization, signal),
    probeAbsent: () => probeAbsent(operatorToken, organization, signal),
    waitForUnknown,
  }
}

function assertOwnedProbe(recovery, state) {
  if (!state?.manifest) throw new Error("ownership_unresolved")
  if (
    state.manifest.agentName !== recovery.serviceName ||
    state.manifest.serviceId !== recovery.probe?.serviceId ||
    state.manifest.buildId !== recovery.probe?.buildId ||
    state.manifest.deploymentId !== recovery.probe?.deploymentId
  )
    throw new Error("ownership_mismatch")
  if (
    !Array.isArray(recovery.privateKeyIds) ||
    JSON.stringify(privateKeyInventory(state.keys)) !==
      JSON.stringify([...recovery.privateKeyIds].sort())
  )
    throw new Error("private_key_inventory_invalid")
}

async function recordOperation(
  store,
  {
    name,
    targetRef = null,
    caseRef = null,
    source = "operator",
    perform,
    signal,
  }
) {
  assertNotAborted(signal)
  const operationRef = safeRef(store.recovery.salt, `${name}:${randomUUID()}`)
  await store.append({
    kind: "operation_intent",
    source,
    caseRef,
    operationRef,
    payload: { name, targetRef },
  })
  try {
    assertNotAborted(signal)
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

async function blockPermission(store, error) {
  if (permissionFailure(error))
    await store.checkpoint((recovery) => {
      recovery.mutationBlocked = true
    })
}

export function assertCaseComplete(recovery, sessionRef) {
  if (recovery.firstFailure) throw new Error(recovery.firstFailure.category)
  const sessions = Object.values(recovery.sessions)
  if (
    !recovery.sessions[sessionRef]?.terminal ||
    sessions.some((session) => !session.terminal)
  )
    throw new Error("session_status_unknown")
  if (sessions.some((session) => !resourceEvidenceComplete(session)))
    throw new Error("session_resource_incomplete")
  if (
    sessions.some(
      (session) =>
        session.observedRuntimeMinutes > LIMITS.providerSeconds / 60 ||
        Date.parse(session.providerEndedAt) > session.deadline
    )
  )
    throw new Error("session_resource_bound_exceeded")
  if (unresolvedDispatches(recovery).length)
    throw new Error("session_status_unknown")
}

export function resourceEvidenceComplete(observation) {
  return (
    observation?.readbackValid !== false &&
    observation?.terminal === true &&
    Number.isFinite(Date.parse(observation.providerStartedAt)) &&
    Number.isFinite(Date.parse(observation.providerEndedAt)) &&
    Number.isFinite(observation.observedRuntimeMinutes) &&
    observation.observedRuntimeMinutes >= 0 &&
    Number.isSafeInteger(observation.metricSampleCount) &&
    observation.metricSampleCount > 0 &&
    Number.isFinite(observation.lastMetricSampleAt) &&
    observation.lastMetricSampleAt > 0 &&
    Number.isFinite(observation.lastCpuMillicores) &&
    observation.lastCpuMillicores >= 0 &&
    Number.isFinite(observation.lastMemoryBytes) &&
    observation.lastMemoryBytes >= 0
  )
}

function unresolvedDispatches(recovery) {
  return (recovery.dispatches ?? []).filter(
    (dispatch) =>
      dispatch.outcome === "unknown" ||
      !Object.values(recovery.sessions).some(
        (session) =>
          session.caseRef === dispatch.caseRef &&
          resourceEvidenceComplete(session)
      )
  )
}

export async function reserveStart(store, dispatch) {
  await store.checkpoint((recovery) => {
    const reserved =
      recovery.reservedSessionMinutes ??
      (recovery.starts * LIMITS.caseSeconds) / 60
    if (
      !Number.isSafeInteger(reserved) ||
      reserved < (recovery.starts * LIMITS.caseSeconds) / 60 ||
      recovery.starts >= LIMITS.starts ||
      reserved + LIMITS.caseSeconds / 60 > LIMITS.billedMinutes
    )
      throw new Error("reservation_limit_exceeded")
    if (
      recovery.dispatches.some(
        (item) => item.dispatchRef === dispatch.dispatchRef
      )
    )
      throw new Error("ambiguous_start_no_retry")
    recovery.starts += 1
    recovery.reservedSessionMinutes = reserved + LIMITS.caseSeconds / 60
    recovery.dispatches.push({
      ...dispatch,
      reservedMinutes: LIMITS.caseSeconds / 60,
      outcome: "unknown",
    })
  })
}

async function snapshotSession(store, sessionRef, dependencies) {
  const session = store.recovery.sessions[sessionRef]
  if (!session) throw new Error("session_status_unknown")
  try {
    assertNotAborted(dependencies.signal)
    const raw = await dependencies.readSession(session.id)
    if (!raw) throw new Error("session_status_unknown")
    const observation = normalizeSessionObservation(raw)
    await store.append({
      kind: "session_status",
      source: "provider_readback",
      caseRef: session.caseRef,
      payload: {
        sessionRef,
        ...observation,
        httpStatus: raw.httpStatus ?? null,
      },
    })
    await store.checkpoint((recovery) =>
      Object.assign(recovery.sessions[sessionRef], observation, {
        readbackValid: true,
      })
    )
    await store.append({
      kind: "resource_observation",
      source: "provider_readback",
      caseRef: session.caseRef,
      payload: { resource: "session_resources", sessionRef, ...observation },
    })
    if (dependencies.now() >= session.deadline) {
      await store.append({
        kind: "resource_observation",
        source: "provider_readback",
        caseRef: session.caseRef,
        payload: { sessionRef, ...observation, deadlineExceeded: true },
      })
      throw new Error("cleanup_deadline_exceeded")
    }
    return observation
  } catch (error) {
    if (error.message !== "cleanup_deadline_exceeded")
      await store.checkpoint((recovery) => {
        recovery.sessions[sessionRef].readbackValid = false
      })
    await blockPermission(store, error)
    await store.append({
      kind: "session_status",
      source: "provider_readback",
      caseRef: session.caseRef,
      payload: {
        sessionRef,
        httpStatus: error.httpStatus ?? null,
        status: dependencies.signal?.aborted
          ? "interrupted"
          : error.message === "provider_timeout"
            ? "timeout"
            : "failed",
        category: safeCategory(error),
      },
    })
    throw error
  }
}

export async function captureZeroActive(store, dependencies, caseRef = null) {
  assertNotAborted(dependencies.signal)
  const state = await dependencies.readProbe()
  assertOwnedProbe(store.recovery, state)
  const observed = await dependencies.readActiveSessions()
  const complete =
    observed?.complete === true &&
    observed?.activeSessionCount === 0 &&
    observed?.httpStatus === 200
  await store.append({
    kind: "resource_observation",
    source: "private_session_readback",
    caseRef,
    payload: {
      resource: "probe_sessions",
      complete,
      activeSessionCount: complete ? 0 : null,
      httpStatus: observed?.httpStatus ?? null,
      deploymentRef: safeRef(
        store.recovery.salt,
        store.recovery.probe.deploymentId
      ),
    },
  })
  await store.checkpoint((recovery) => {
    recovery.cleanup.zeroActiveComplete = complete
  })
  if (!complete) throw new Error("active_sessions_unresolved")
  return true
}

export async function countedStop(
  store,
  sessionRef,
  dependencies,
  name = "stop_session"
) {
  const session = store.recovery.sessions[sessionRef]
  if (!session) throw new Error("session_status_unknown")
  assertNotAborted(dependencies.signal)
  const spacing =
    session.stopAttempts === 0 ? 0 : session.stopAttempts === 1 ? 5_000 : 15_000
  const lastAttemptAt = session.lastStopAttemptAt ?? 0
  if (
    !mutationBlocked(store.recovery) &&
    session.stopAttempts < 3 &&
    dependencies.now() < session.deadline &&
    dependencies.now() < lastAttemptAt + spacing
  ) {
    await dependencies.sleep(
      Math.min(lastAttemptAt + spacing, session.deadline) - dependencies.now()
    )
  }
  const observation = await snapshotSession(store, sessionRef, dependencies)
  if (mutationBlocked(store.recovery))
    throw new Error("session_permission_denied")
  if (observation.terminal && name !== "repeat_stop_session")
    return { status: "terminal", observation }
  if (session.stopAttempts >= 3) throw new Error("session_stop_exhausted")
  assertNotAborted(dependencies.signal)
  const attempt = session.stopAttempts + 1
  await store.checkpoint((recovery) => {
    recovery.sessions[sessionRef].stopAttempts = attempt
    recovery.sessions[sessionRef].lastStopAttemptAt = dependencies.now()
  })
  let result
  try {
    result = await recordOperation(store, {
      name,
      signal: dependencies.signal,
      targetRef: sessionRef,
      caseRef: session.caseRef,
      source: session.sources.includes("application_registration")
        ? "application_recovery"
        : "operator_intervention",
      perform: () => {
        if (dependencies.now() >= session.deadline)
          throw new Error("cleanup_deadline_exceeded")
        if (mutationBlocked(store.recovery))
          throw new Error("session_permission_denied")
        return dependencies.stopSession(session.id)
      },
    })
  } catch (error) {
    await blockPermission(store, error)
    throw error
  }
  await store.checkpoint((recovery) =>
    recovery.sessions[sessionRef].stopHistory.push(result)
  )
  if (result.status === "permission_error") {
    await blockPermission(store, new Error("session_permission_denied"))
    throw new Error("session_permission_denied")
  }
  if (result.status === "invalid_response")
    throw new Error("session_identity_mismatch")
  return result
}

export async function reconcileSession(store, sessionRef, dependencies) {
  while (true) {
    if (dependencies.observeOnly) {
      const observation = await snapshotSession(store, sessionRef, dependencies)
      if (observation.terminal) return observation
      await dependencies.sleep(
        Math.min(
          5_000,
          store.recovery.sessions[sessionRef].deadline - dependencies.now()
        )
      )
    } else {
      const result = await countedStop(store, sessionRef, dependencies)
      if (result.status === "terminal") return result.observation
    }
  }
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
  let mutationsBlocked = mutationBlocked(store.recovery)
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
      mutationsBlocked = true
    await blockPermission(store, error)
  }

  if (ownedState) {
    for (const sessionRef of Object.keys(store.recovery.sessions)) {
      try {
        await reconcileSession(store, sessionRef, dependencies)
      } catch (error) {
        cleanupErrors.push(error)
        await blockPermission(store, error)
      }
    }
    for (const dispatch of unresolvedDispatches(store.recovery)) {
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
    let zeroActive = false
    try {
      zeroActive = await captureZeroActive(store, dependencies)
    } catch (error) {
      await blockPermission(store, error)
      cleanupErrors.push(error)
    }
    const targetsComplete =
      Object.values(store.recovery.sessions).every(resourceEvidenceComplete) &&
      unresolvedDispatches(store.recovery).length === 0
    if (!targetsComplete)
      cleanupErrors.push(new Error("session_resource_incomplete"))
    if (
      !mutationsBlocked &&
      !mutationBlocked(store.recovery) &&
      zeroActive &&
      targetsComplete
    ) {
      try {
        const result = await recordOperation(store, {
          name: "delete_probe_service",
          signal: dependencies.signal,
          targetRef: safeRef(
            store.recovery.salt,
            store.recovery.probe.deploymentId
          ),
          perform: () => {
            if (
              unresolvedDispatches(store.recovery).length ||
              !Object.values(store.recovery.sessions).every(
                resourceEvidenceComplete
              )
            )
              throw new Error("session_status_unknown")
            return dependencies.deleteProbe()
          },
        })
        await store.checkpoint((recovery) => {
          recovery.cleanup.deleteProbe = result
          if (result.status === "permission_error")
            recovery.mutationBlocked = true
        })
        if (result.status === "permission_error")
          throw new Error("session_permission_denied")
      } catch (error) {
        await blockPermission(store, error)
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
    await blockPermission(store, error)
    cleanupErrors.push(error)
  }

  try {
    const production = await dependencies.readProduction()
    const unchanged = verifyBaseline(
      production.manifest,
      production.sessions,
      production.keys,
      production.secretSets,
      store.recovery.privateKeyIds ?? null
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
    await blockPermission(store, error)
    cleanupErrors.push(error)
  }

  const unresolvedSessions = Object.values(store.recovery.sessions).filter(
    (session) => !resourceEvidenceComplete(session)
  ).length
  await store.checkpoint((recovery) => {
    recovery.cleanup.unresolvedSessions = unresolvedSessions
    recovery.cleanup.completed =
      cleanupErrors.length === 0 &&
      !mutationBlocked(recovery) &&
      unresolvedSessions === 0 &&
      unresolvedDispatches(recovery).length === 0 &&
      recovery.cleanup.zeroActiveComplete === true &&
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

export async function containFromMemory(store, dependencies) {
  if (mutationBlocked(store.recovery) || dependencies.signal?.aborted)
    return false
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
        assertNotAborted(dependencies.signal)
        if (session.stopAttempts >= 3 || dependencies.now() >= session.deadline)
          continue
        const spacing =
          session.stopAttempts === 0
            ? 0
            : session.stopAttempts === 1
              ? 5_000
              : 15_000
        if (dependencies.now() < (session.lastStopAttemptAt ?? 0) + spacing)
          continue
        session.stopAttempts += 1
        session.lastStopAttemptAt = dependencies.now()
        const result = await dependencies.stopSession(session.id)
        session.stopHistory.push(result)
        if (result.status === "permission_error") {
          store.recovery.mutationBlocked = true
          return false
        }
      }
    } catch (error) {
      if (permissionFailure(error)) {
        store.recovery.mutationBlocked = true
        return false
      }
      if (dependencies.signal?.aborted) return false
    }
  }
  // Disk failure prevents durable terminal/zero-active evidence. Preserve the lookup surface.
  return false
}

async function runLive(runDir) {
  if (process.env.PROVIDER_PROOF_LIVE_RELEASE !== LIVE_RELEASE)
    throw new Error("live_release_missing")
  const runId = process.env.PROVIDER_PROOF_RUN_ID
  const publicKey = process.env.PIPECAT_API_KEY
  const privateKey = process.env.PIPECAT_PRIVATE_API_KEY
  const operatorToken = process.env.PIPECAT_OPERATOR_TOKEN
  const organization = process.env.PIPECAT_ORGANIZATION
  if (!privateKey) throw new Error("private_key_missing")
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
  let cleanupStarted = false
  let evidenceWritable = true
  const controller = new AbortController()
  const cleanupController = new AbortController()
  exerciseSignal = controller.signal
  const onSignal = () => {
    if (controller.signal.aborted || cleanupStarted) {
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
    const privateKeyIds = privateKeyInventory(preflight.keys)
    if (
      !verifyBaseline(
        preflight.manifest,
        preflight.sessions,
        preflight.keys,
        preflight.secretSets,
        privateKeyIds
      )
    )
      throw new Error("baseline_preflight_failed")
    await store.checkpoint((recovery) => {
      recovery.privateKeyIds = privateKeyIds
    })
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
        serviceId: reconciled.state.manifest.serviceId,
      }
    })
    await store.append({
      kind: "operation_result",
      source: "operator",
      operationRef: deployRef,
      payload: { name: "deploy_probe", ...reconciled.diagnostic },
    })
    await captureZeroActive(
      store,
      cleanupDependencies({
        operatorToken,
        organization,
        privateKey,
        recovery: store.recovery,
        signal: controller.signal,
      })
    )

    for (const definition of CASES) {
      assertNotAborted(controller.signal)
      if (store.recovery.firstFailure)
        throw new Error(store.recovery.firstFailure.category)
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
      await reserveStart(store, {
        dispatchRef,
        caseRef: definition.id,
        dispatchedAt,
        deadline,
        providerDeadline: dispatchedAt + LIMITS.providerSeconds * 1_000,
        expiresAtEpochSeconds: expiresAt,
        providerLifetimeStart: "local_dispatch_pending_provider_timestamp",
      })
      currentOperation = "start_session"
      await store.append({
        kind: "operation_intent",
        source: "application",
        caseRef: definition.id,
        operationRef: dispatchRef,
        payload: {
          name: "start_session",
          reservedMinutes: LIMITS.caseSeconds / 60,
          deadline: new Date(deadline).toISOString(),
        },
      })
      let operatorResponse
      try {
        if (store.recovery.firstFailure)
          throw new Error(store.recovery.firstFailure.category)
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
        typeof operatorResponse?.sessionId !== "string" ||
        !operatorResponse.sessionId
      )
        throw new Error("start_response_invalid")
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
      if (
        ![operatorResponse.dailyRoom, operatorResponse.dailyToken].every(
          (value) => typeof value === "string" && value.length > 0
        )
      )
        throw new Error("start_response_invalid")
      assertBoundedClaims(decodeClaims(operatorResponse.dailyToken), expiresAt)
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
        await reconcileSession(store, sessionRef, {
          ...cleanupDependencies({
            operatorToken,
            organization,
            privateKey,
            recovery: store.recovery,
            signal: controller.signal,
          }),
          observeOnly: true,
        })
      } else if (applicationSessionId) {
        const cleanupRef = safeRef(store.recovery.salt, applicationSessionId)
        await reconcileSession(
          store,
          cleanupRef,
          cleanupDependencies({
            operatorToken,
            organization,
            privateKey,
            recovery: store.recovery,
            signal: controller.signal,
          })
        )
        if (definition.stop === "twice")
          await countedStop(
            store,
            cleanupRef,
            cleanupDependencies({
              operatorToken,
              organization,
              privateKey,
              recovery: store.recovery,
              signal: controller.signal,
            }),
            "repeat_stop_session"
          )
      }
      if (
        definition.stop !== "ceiling" &&
        !store.records.some(
          (record) =>
            record.caseRef === definition.id &&
            record.kind === "operation_result" &&
            record.payload.name === "stop_session" &&
            record.payload.status === "success" &&
            record.payload.httpStatus === 200
        )
      )
        throw new Error("session_stop_unverified")
      if (
        definition.stop === "twice" &&
        !store.records.some(
          (record) =>
            record.caseRef === definition.id &&
            record.kind === "operation_result" &&
            record.payload.name === "repeat_stop_session" &&
            record.payload.httpStatus === 404
        )
      )
        throw new Error("repeat_stop_unverified")
      assertCaseComplete(store.recovery, sessionRef)
      await captureZeroActive(
        store,
        cleanupDependencies({
          operatorToken,
          organization,
          privateKey,
          recovery: store.recovery,
          signal: controller.signal,
        }),
        definition.id
      )
      await store.append({
        kind: "verdict",
        source: "operator",
        caseRef: definition.id,
        payload: {
          status: "pass",
          reason: "case_resource_observations_complete",
        },
      })
    }
  } catch (error) {
    try {
      await store.latchFailure({
        caseRef: currentCase,
        operationRef: currentOperation,
        category: safeCategory(error),
        predicate: currentOperation ?? "run_preflight",
      })
    } catch {
      evidenceWritable = false
    }
  } finally {
    exerciseSignal = null
  }

  if (!secondSignal) {
    cleanupStarted = true
    const dependencies = cleanupDependencies({
      operatorToken,
      organization,
      privateKey,
      recovery: store.recovery,
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
    store.recovery.cleanup.completed === true && !store.recovery.firstFailure
      ? "pass"
      : "blocked"
  const reason = secondSignal
    ? "cleanup_interrupted_recovery_required"
    : (store.recovery.firstFailure?.category ??
      (status === "pass" ? "resource_proof_complete" : "cleanup_unverified"))
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
    `${JSON.stringify({ resourceStatus: summary.status, accountingStatus: before.accountingStatus, reason: summary.reason ?? reason, runDir: store.runDir })}\n`
  )
  process.exitCode = summary.status === "pass" ? 0 : 1
}

async function recover(runDir) {
  const operatorToken = process.env.PIPECAT_OPERATOR_TOKEN
  const privateKey = process.env.PIPECAT_PRIVATE_API_KEY
  const organization = process.env.PIPECAT_ORGANIZATION
  if (!privateKey) throw new Error("private_key_missing")
  if (![operatorToken, organization, runDir].every(Boolean))
    throw new Error("recover_prerequisite_missing")
  const store = await DurableRunStore.open(runDir)
  const controller = new AbortController()
  const onSignal = () => controller.abort()
  process.on("SIGINT", onSignal)
  process.on("SIGTERM", onSignal)
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
      cleanupDependencies({
        operatorToken,
        organization,
        privateKey,
        recovery: store.recovery,
        signal: controller.signal,
      })
    )
    const before = projectSummary(
      store.records,
      store.recovery,
      store.truncatedTail
    )
    const status =
      completed && !store.recovery.firstFailure ? "pass" : "blocked"
    const reason =
      store.recovery.firstFailure?.category ??
      (status === "pass" ? "resource_proof_complete" : "cleanup_unverified")
    await store.append({
      kind: "verdict",
      source: "recovery",
      payload: { status, reason },
    })
    const summary = await store.writeSummary()
    process.stdout.write(
      `${JSON.stringify({ resourceStatus: summary.status, accountingStatus: before.accountingStatus, reason: summary.reason ?? reason, runDir: store.runDir })}\n`
    )
    process.exitCode = summary.status === "pass" ? 0 : 1
  } catch (error) {
    await store.latchFailure({
      category: safeCategory(error),
      predicate: "recovery_cleanup",
    })
    await store.append({
      kind: "verdict",
      source: "recovery",
      payload: { status: "blocked", reason: safeCategory(error) },
    })
    await store.writeSummary()
    process.exitCode = 1
  } finally {
    process.removeListener("SIGINT", onSignal)
    process.removeListener("SIGTERM", onSignal)
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
