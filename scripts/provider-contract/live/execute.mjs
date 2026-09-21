#!/usr/bin/env node

import process from "node:process"
import { randomUUID } from "node:crypto"

import { safeReference } from "../lib/contract.mjs"
import { createDeployCommands } from "./commands.mjs"
import { createCollector } from "./collector.mjs"
import { buildLiveEvidence, writeSecretFreeEvidence } from "./evidence.mjs"
import { ControlPlaneClient, ProviderClient } from "./provider.mjs"
import { createRunSecret, signActivation } from "./protocol.mjs"
import {
  BASELINE,
  LiveRunState,
  abortAndRestore,
  createOperatorGuard,
} from "./run-state.mjs"
import { createNgrokTunnel } from "./tunnel.mjs"
import { createFileOperatorWitness, decodeBrowserClaims } from "./witness.mjs"

export const CASES = Object.freeze([
  {
    caseId: "cold_start",
    mode: "register_join_wait",
    injection: "min_agents=0 cold start",
    termination: "stop",
  },
  {
    caseId: "cancel_before_join",
    mode: "register_pause_before_join",
    injection: "cancel after start response and before browser join",
    termination: "stop",
  },
  {
    caseId: "lost_start_response_registered",
    mode: "register_join_wait",
    injection:
      "discard application start response while retaining operator witness",
    termination: "stop",
  },
  {
    caseId: "no_registration_startup",
    mode: "no_register_join_wait",
    injection:
      "discard application start response and suppress application registration",
    termination: "ceiling",
  },
  {
    caseId: "hung_runtime",
    mode: "register_join_wait",
    injection:
      "keep the runtime alive after both media participants are ejected",
    termination: "ceiling",
  },
  {
    caseId: "known_session_stop_retry",
    mode: "register_pause_before_join",
    injection: "repeat cleanup against the same exact provider session",
    termination: "retry",
  },
])

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function isoFromEpoch(seconds) {
  return new Date(seconds * 1_000).toISOString()
}

function safeError(error) {
  return error instanceof Error
    ? error.message
    : "live provider exercise failed"
}

function assertRelease(environment) {
  if (
    environment.PROVIDER_CONTRACT_LIVE_RELEASE !==
    "stage-a-provider-proof-live-release"
  ) {
    throw new Error("live provider release is not present")
  }
  if (
    environment.PROVIDER_CONTRACT_SECRET_SET_APPROVED !==
    "duplexd-provider-proof"
  ) {
    throw new Error("temporary probe secret-set approval is not present")
  }
  if (!environment.PROVIDER_CONTRACT_RUN_ID)
    throw new Error("approved run ID is required")
  if (!environment.PROVIDER_CONTRACT_EVIDENCE_PATH)
    throw new Error("evidence path is required")
}

function validateProbeManifest(manifest) {
  const errors = []
  if (manifest.agentName !== BASELINE.agentName) errors.push("agent mismatch")
  if (manifest.minAgents !== 0 || manifest.maxAgents !== 1)
    errors.push("probe scaling mismatch")
  if (manifest.secretSet !== "duplexd-provider-proof")
    errors.push("probe secret-set mismatch")
  if (manifest.maxSessionDurationSeconds !== 600)
    errors.push("provider ceiling mismatch")
  if (
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(manifest.buildId)
  ) {
    errors.push("probe build ID is not a full UUID")
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(manifest.imageDigest)) {
    errors.push("probe image digest is invalid")
  }
  if (
    manifest.buildId === BASELINE.buildId ||
    manifest.imageDigest === BASELINE.imageDigest
  ) {
    errors.push("probe image did not replace the baseline image")
  }
  if (errors.length > 0)
    throw new Error(`probe manifest rejected: ${errors.join(", ")}`)
}

function assertRunActive(state) {
  if (state.counters().aborted) throw new Error("live provider run is aborted")
}

function usageMarker(metrics) {
  if (
    metrics === null ||
    typeof metrics !== "object" ||
    !Number.isSafeInteger(metrics.sampleCount) ||
    metrics.sampleCount < 1 ||
    !Array.isArray(metrics.timeseries) ||
    metrics.timeseries.length < 1
  ) {
    throw new Error("exact-session resource usage is unavailable")
  }
  const lastSample = metrics.timeseries.at(-1)
  if (!Number.isFinite(lastSample?.t)) {
    throw new Error("exact-session resource usage is invalid")
  }
  return `${metrics.sampleCount}:${lastSample.t}`
}

function assertBoundedMediaClaims(claims, expiresAtEpochSeconds, participant) {
  if (
    claims.expiresAtEpochSeconds !== expiresAtEpochSeconds ||
    claims.ejectAtTokenExpiry !== true ||
    claims.isOwner !== false ||
    claims.roomScoped !== true
  ) {
    throw new Error(`${participant} Daily claims are not safely bounded`)
  }
}

async function waitForProbeManifest(provider, guard, { sleep = delay } = {}) {
  let lastError = new Error("probe manifest readback did not run")
  for (let attempt = 0; attempt < 24; attempt += 1) {
    assertRunActive(guard.state)
    try {
      const manifest = await provider.readManifest()
      validateProbeManifest(manifest)
      return manifest
    } catch (error) {
      lastError = error
    }
    await Promise.race([
      sleep(5_000),
      guard.abortSignal.then((reason) => {
        throw new Error(`run aborted: ${reason}`)
      }),
    ])
  }
  throw lastError
}

async function waitForBaseline(controlPlane, { sleep = delay } = {}) {
  let last = null
  for (let attempt = 0; attempt < 24; attempt += 1) {
    last = await controlPlane.readManifest()
    if (
      last.agentName === BASELINE.agentName &&
      last.buildId === BASELINE.buildId &&
      last.imageDigest === BASELINE.imageDigest &&
      last.minAgents === BASELINE.minAgents &&
      last.maxAgents === BASELINE.maxAgents &&
      last.secretSet === BASELINE.secretSet &&
      !Object.hasOwn(last, "maxSessionDurationSeconds")
    ) {
      return last
    }
    await sleep(5_000)
  }
  throw new Error("baseline manifest did not become active")
}

async function reconcileEnded(
  provider,
  sessionId,
  guard,
  { sleep = delay } = {}
) {
  let ended = null
  for (;;) {
    const detail = await provider.session(sessionId)
    if (detail.endedAt !== null) {
      ended = detail
      break
    }
    await Promise.race([
      sleep(5_000),
      guard.abortSignal.then((reason) => {
        throw new Error(`run aborted: ${reason}`)
      }),
    ])
  }
  await Promise.race([
    sleep(5_000),
    guard.abortSignal.then((reason) => {
      throw new Error(`run aborted: ${reason}`)
    }),
  ])
  const stable = await provider.session(sessionId)
  const endedUsageMarker = usageMarker(ended.resourceMetrics)
  const stableUsageMarker = usageMarker(stable.resourceMetrics)
  if (
    stable.endedAt !== ended.endedAt ||
    stable.updatedAt !== ended.updatedAt ||
    stableUsageMarker !== endedUsageMarker
  ) {
    throw new Error(
      "exact-session usage/status did not stabilize after termination"
    )
  }
  return stable
}

function observation(source, sessionRef, fact, observedAt) {
  return { kind: "live", source, sessionRef, fact, observedAt }
}

function buildCaseEvidence({
  definition,
  runId,
  sessionRef,
  dispatchedAt,
  readyAt,
  ceasedAt,
  expiresAt,
  browserClaims,
  agentClaims,
  callbackTimes,
  browserEjectedAt,
  stopAttempts,
  status,
}) {
  const observations = []
  const checks = {}
  if (definition.caseId === "cold_start") {
    checks.startResponseFields = true
    checks.registrationMatched = true
    observations.push(
      observation(
        "start_response",
        sessionRef,
        "Start returned all required fields.",
        dispatchedAt
      ),
      observation(
        "runner_registration",
        sessionRef,
        "Runner registered the exact start-response session.",
        callbackTimes.registered
      )
    )
  }
  if (
    ["cancel_before_join", "lost_start_response_registered"].includes(
      definition.caseId
    )
  ) {
    checks.knownSessionStopTargetStable = true
    checks.processTerminated = true
    checks.usageCeased = true
    if (definition.caseId === "lost_start_response_registered") {
      checks.registrationMatched = true
      observations.push(
        observation(
          "runner_registration",
          sessionRef,
          "Out-of-band runner registration recovered the exact session.",
          callbackTimes.registered
        )
      )
    }
  }
  if (["no_registration_startup", "hung_runtime"].includes(definition.caseId)) {
    checks.providerExecutionCeilingObserved = true
    checks.browserEjected = true
    checks.agentEjected = true
    checks.processTerminated = true
    checks.usageCeased = true
    observations.push(
      observation(
        "daily_browser_event",
        sessionRef,
        "Operator observed browser ejection at bounded credential expiry.",
        browserEjectedAt
      ),
      observation(
        "daily_agent_event",
        sessionRef,
        "Probe observed agent ejection at bounded credential expiry.",
        callbackTimes.agent_left
      )
    )
  }
  if (definition.caseId === "known_session_stop_retry") {
    checks.knownSessionStopTargetStable = true
    checks.stop404Reconciled = true
    checks.processTerminated = true
    checks.usageCeased = true
  }
  if (checks.knownSessionStopTargetStable) {
    observations.push(
      observation(
        "stop_response",
        sessionRef,
        "Cleanup targeted the exact known session.",
        ceasedAt
      )
    )
  }
  if (
    checks.processTerminated ||
    checks.providerExecutionCeilingObserved ||
    checks.stop404Reconciled
  ) {
    observations.push(
      observation(
        "provider_session_status",
        sessionRef,
        `Exact-session status ended with ${status.completionStatus ?? "provider status"}.`,
        status.updatedAt
      )
    )
  }
  if (checks.usageCeased) {
    observations.push(
      observation(
        "provider_usage",
        sessionRef,
        "Exact-session usage/resource timestamps remained stable after termination.",
        status.updatedAt
      )
    )
  }
  return {
    case: definition.caseId,
    observation: "live",
    injection: definition.injection,
    sessionRef,
    callRef: safeReference(`${runId}:${definition.caseId}`),
    dispatchedAt,
    ...(readyAt === null ? {} : { readyAt }),
    ceasedAt,
    media: {
      sessionRef,
      room: { expiresAt, observedAt: dispatchedAt, ejectAtExpiry: true },
      browser: {
        expiresAt: isoFromEpoch(browserClaims.expiresAtEpochSeconds),
        observedAt: dispatchedAt,
        ejectAtExpiry: browserClaims.ejectAtTokenExpiry,
        isOwner: browserClaims.isOwner,
        roomScoped: browserClaims.roomScoped,
      },
      agent: {
        expiresAt: isoFromEpoch(agentClaims.expiresAtEpochSeconds),
        observedAt: callbackTimes.agent_claims,
        ejectAtExpiry: agentClaims.ejectAtTokenExpiry,
        roomScoped: agentClaims.roomScoped,
      },
    },
    cessationBoundary:
      definition.termination === "ceiling"
        ? "provider_execution_ceiling"
        : "provider_stop",
    checks,
    ...(stopAttempts.length === 0 ? {} : { stopAttempts }),
    observations,
  }
}

async function waitForCollector(collector, bootId, event, guard) {
  const value = await Promise.race([
    collector.waitFor(bootId, event),
    guard.abortSignal.then((reason) => {
      throw new Error(`run aborted: ${reason}`)
    }),
  ])
  if (value === null) throw new Error("collector closed before required event")
  return value
}

async function waitForWitness(witness, caseId, event, guard) {
  return Promise.race([
    witness.expect(caseId, event),
    guard.abortSignal.then((reason) => {
      throw new Error(`run aborted: ${reason}`)
    }),
  ])
}

async function runCase({
  definition,
  runId,
  callbackUrl,
  callbackSecret,
  activationSecret,
  provider,
  collector,
  witness,
  guard,
  mutate,
  now = () => Date.now(),
  sleep = delay,
}) {
  guard.beginCase(definition.caseId)
  const bootId = randomUUID()
  const dispatchedAt = new Date(now()).toISOString()
  const expiresAtEpochSeconds = Math.floor(now() / 1_000) + 300
  const probe = {
    version: 1,
    runId,
    caseId: definition.caseId,
    bootId,
    mode: definition.mode,
    callbackUrl,
    callbackSecret,
  }
  probe.activationProof = signActivation({
    secret: activationSecret,
    config: probe,
  })
  const operatorStart = await mutate(async () => {
    const value = await provider.start({
      body: { providerContractProbe: probe },
      expiresAtEpochSeconds,
    })
    guard.state.recordOperatorWitness(definition.caseId, value.sessionId)
    if (definition.caseId !== "lost_start_response_registered") {
      guard.state.recordStart(definition.caseId, value.sessionId)
    }
    return value
  })
  let cleanupSessionId =
    definition.caseId === "lost_start_response_registered"
      ? null
      : operatorStart.sessionId
  let sessionRef =
    cleanupSessionId === null ? null : safeReference(cleanupSessionId)
  const browserClaims = decodeBrowserClaims(operatorStart.dailyToken)
  assertBoundedMediaClaims(browserClaims, expiresAtEpochSeconds, "browser")
  if (definition.mode !== "register_pause_before_join") {
    await witness.publishJoin(definition.caseId, {
      dailyRoom: operatorStart.dailyRoom,
      dailyToken: operatorStart.dailyToken,
    })
  }

  const callbackTimes = {}
  let agentClaims
  let readyAt = null
  if (definition.mode !== "no_register_join_wait") {
    const registered = await waitForCollector(
      collector,
      bootId,
      "registered",
      guard
    )
    guard.state.recordRegistration(definition.caseId, registered.sessionId)
    if (registered.sessionId !== operatorStart.sessionId) {
      throw new Error("registered callback session mismatch")
    }
    if (definition.caseId === "lost_start_response_registered") {
      cleanupSessionId = registered.sessionId
      sessionRef = safeReference(cleanupSessionId)
    }
    callbackTimes.registered = new Date(
      registered.observedAt * 1_000
    ).toISOString()
    callbackTimes.agent_claims = callbackTimes.registered
    agentClaims = registered.dailyClaims
    if (definition.mode === "register_pause_before_join")
      guard.state.markReady(definition.caseId)
  }
  if (definition.mode !== "register_pause_before_join") {
    await waitForWitness(witness, definition.caseId, "browser_joined", guard)
    const joined = await waitForCollector(
      collector,
      bootId,
      "agent_joined",
      guard
    )
    if (joined.sessionId !== operatorStart.sessionId)
      throw new Error("joined callback session mismatch")
    readyAt = new Date(joined.observedAt * 1_000).toISOString()
    callbackTimes.agent_claims = readyAt
    agentClaims = joined.dailyClaims
    guard.state.markReady(definition.caseId)
  }
  if (agentClaims === undefined)
    throw new Error("agent media claims were not observed")
  assertBoundedMediaClaims(agentClaims, expiresAtEpochSeconds, "agent")

  const stopAttempts = []
  let browserEjectedAt = null
  if (definition.termination === "ceiling") {
    browserEjectedAt = await waitForWitness(
      witness,
      definition.caseId,
      "browser_ejected",
      guard
    )
    const left = await waitForCollector(collector, bootId, "agent_left", guard)
    if (left.sessionId !== operatorStart.sessionId)
      throw new Error("left callback session mismatch")
    callbackTimes.agent_left = new Date(left.observedAt * 1_000).toISOString()
  } else {
    if (cleanupSessionId === null || sessionRef === null) {
      throw new Error("registered cleanup session is unavailable")
    }
    const stopped = await mutate(() => provider.stop(cleanupSessionId))
    stopAttempts.push({ sessionRef, httpStatus: stopped.status })
    if (stopped.status !== 200) {
      throw new Error("initial exact-session stop did not return HTTP 200")
    }
    if (definition.termination === "retry") {
      const retried = await mutate(() => provider.stop(cleanupSessionId))
      stopAttempts.push({ sessionRef, httpStatus: retried.status })
      if (retried.status !== 404)
        throw new Error("cleanup retry did not produce a reconcilable 404")
    }
  }

  const reconciliationSessionId = cleanupSessionId ?? operatorStart.sessionId
  const status = await reconcileEnded(
    provider,
    reconciliationSessionId,
    guard,
    {
      sleep,
    }
  )
  const ceasedAt = status.endedAt
  const finished = guard.finishCase(definition.caseId, {
    billedMinutes: status.billedMinutes,
    endedAt: Date.parse(ceasedAt),
  })
  await witness.clearCase()
  return buildCaseEvidence({
    definition,
    runId,
    sessionRef: finished.sessionRef,
    dispatchedAt,
    readyAt,
    ceasedAt,
    expiresAt: isoFromEpoch(expiresAtEpochSeconds),
    browserClaims,
    agentClaims,
    callbackTimes,
    browserEjectedAt,
    stopAttempts,
    status,
  })
}

export async function runLiveExercise({
  environment = process.env,
  controlPlane,
  providerFactory,
  deployCommands = createDeployCommands(),
  collectorFactory = createCollector,
  tunnel = createNgrokTunnel(),
  witness,
  state = new LiveRunState(),
  sleep = delay,
  now = () => Date.now(),
  onGuard = () => {},
}) {
  assertRelease(environment)
  const publicKey = environment.PIPECAT_API_KEY
  if (!publicKey) throw new Error("PIPECAT_API_KEY is required")
  const runId = environment.PROVIDER_CONTRACT_RUN_ID
  const callbackSecret = createRunSecret()
  const activationSecret = createRunSecret()
  const collector = collectorFactory({
    secret: callbackSecret,
    runId,
    caseIds: CASES.map(({ caseId }) => caseId),
  })
  let privateKey = null
  let privateKeyId = null
  let provider = null
  let secretSetCreated = false
  let probeDeployed = false
  let cleanupResult = null
  let probeManifest = null
  let inFlightMutation = Promise.resolve()

  function mutate(task) {
    assertRunActive(state)
    const operation = inFlightMutation.then(() => {
      assertRunActive(state)
      return task()
    })
    inFlightMutation = operation.catch(() => {})
    return operation
  }

  const cleanup = async (reason) => {
    if (cleanupResult !== null) return cleanupResult
    await inFlightMutation
    cleanupResult = await abortAndRestore({
      state,
      stopSession: async (sessionId) => {
        if (provider === null)
          throw new Error("private provider client is unavailable")
        await provider.stop(sessionId)
      },
      restoreBaseline: async () => {
        if (!probeDeployed) return
        await controlPlane.restoreBaseline(BASELINE)
        await waitForBaseline(controlPlane, { sleep })
      },
      revokePrivateKey: async () => {
        const keys = await controlPlane.listKeys()
        const temporary = keys.filter(
          (key) =>
            key.name === "Stage A provider proof" && key.type === "private"
        )
        for (const key of temporary) await controlPlane.revokeKey(key.id)
      },
      deleteProbeSecretSet: async () => {
        if (secretSetCreated) await controlPlane.deleteProbeSecretSet()
      },
      readback: async () => ({
        manifest: await controlPlane.readManifest(),
        sessions: (await controlPlane.listSessions()).filter(
          (session) => session.endedAt === null
        ),
        keys: await controlPlane.listKeys(),
        secretSets: await controlPlane.listSecretSets(),
      }),
    })
    cleanupResult.reason = reason
    try {
      await tunnel.close()
    } catch {
      cleanupResult.cleanupErrors.push("tunnel close failed")
    }
    try {
      await collector.close()
    } catch {
      cleanupResult.cleanupErrors.push("collector close failed")
    }
    witness.cancelInput?.()
    cleanupResult.ok =
      cleanupResult.cleanupErrors.length === 0 && cleanupResult.verification.ok
    if (!cleanupResult.ok) {
      try {
        await witness.preserveContainment({
          reason,
          containment: cleanupResult.containment,
          cleanupErrors: cleanupResult.cleanupErrors,
          verification: cleanupResult.verification,
          volatileKnownSessionIds: cleanupResult.volatileKnownSessionIds,
          volatileProviderState: cleanupResult.volatileProviderState,
          privateKeyId,
        })
      } catch {
        cleanupResult.cleanupErrors.push("containment record failed")
      }
    }
    try {
      await witness.close({ destroy: cleanupResult.ok })
    } catch {
      cleanupResult.cleanupErrors.push("witness close failed")
      cleanupResult.ok = false
      try {
        await witness.preserveContainment({
          reason,
          cleanupErrors: cleanupResult.cleanupErrors,
          verification: cleanupResult.verification,
          volatileKnownSessionIds: cleanupResult.volatileKnownSessionIds,
          volatileProviderState: cleanupResult.volatileProviderState,
          privateKeyId,
        })
      } catch {
        // The safe error list remains available to the caller and stderr.
      }
    }
    return cleanupResult
  }
  const guard = createOperatorGuard({ state, cleanup })
  onGuard(guard)

  try {
    assertRunActive(state)
    const baseline = await controlPlane.readManifest()
    if (
      baseline.agentName !== BASELINE.agentName ||
      baseline.buildId !== BASELINE.buildId ||
      baseline.imageDigest !== BASELINE.imageDigest ||
      baseline.minAgents !== BASELINE.minAgents ||
      baseline.maxAgents !== BASELINE.maxAgents ||
      baseline.secretSet !== BASELINE.secretSet ||
      Object.hasOwn(baseline, "maxSessionDurationSeconds")
    ) {
      throw new Error("provider baseline does not match the pinned preflight")
    }
    const [preflightSessions, preflightKeys, preflightSecretSets] =
      await Promise.all([
        controlPlane.listSessions(),
        controlPlane.listKeys(),
        controlPlane.listSecretSets(),
      ])
    if (preflightSessions.some((session) => session.endedAt === null)) {
      throw new Error("provider preflight found an active session")
    }
    if (preflightKeys.some((key) => key.type === "private")) {
      throw new Error("provider preflight found an existing private key")
    }
    if (
      preflightSecretSets.some((set) => set.name === "duplexd-provider-proof")
    ) {
      throw new Error("provider preflight found a stale probe secret set")
    }
    assertRunActive(state)
    const address = await mutate(() => collector.listen())
    const callbackUrl = await mutate(() => tunnel.open(address.port))
    assertRunActive(state)
    secretSetCreated = true
    await mutate(() =>
      controlPlane.createProbeSecretSet({
        PROVIDER_CONTRACT_PROBE_ENABLED: "stage-a-provider-proof",
        PROVIDER_CONTRACT_PROBE_RUN_ID: runId,
        PROVIDER_CONTRACT_PROBE_CALLBACK_URL: callbackUrl,
        PROVIDER_CONTRACT_PROBE_ACTIVATION_SECRET: activationSecret,
      })
    )
    assertRunActive(state)
    const key = await mutate(() =>
      controlPlane.createPrivateKey("Stage A provider proof")
    )
    if (key.name !== "Stage A provider proof" || key.type !== "private") {
      throw new Error("provider returned the wrong temporary key identity")
    }
    privateKey = key.key
    privateKeyId = key.id
    provider = providerFactory({ publicKey, privateKey })
    assertRunActive(state)
    probeDeployed = true
    await mutate(() => deployCommands.deployProbe())
    assertRunActive(state)
    await mutate(() => provider.setMaxSessionDuration(600))
    probeManifest = await waitForProbeManifest(controlPlane, guard, { sleep })
    assertRunActive(state)

    const cases = []
    for (const definition of CASES) {
      assertRunActive(state)
      cases.push(
        await runCase({
          definition,
          runId,
          callbackUrl,
          callbackSecret,
          activationSecret,
          provider,
          collector,
          witness,
          guard,
          mutate,
          now,
          sleep,
        })
      )
    }
    const evidence = buildLiveEvidence({
      runId,
      cases,
      probeManifest: {
        deploymentId: probeManifest.deploymentId,
        buildId: probeManifest.buildId,
        imageDigest: probeManifest.imageDigest,
        maxSessionDurationSeconds: probeManifest.maxSessionDurationSeconds,
      },
    })
    const restored = await guard.abort("completed")
    if (!restored.ok)
      throw new Error("rollback verification failed; containment preserved")
    await writeSecretFreeEvidence(
      environment.PROVIDER_CONTRACT_EVIDENCE_PATH,
      evidence
    )
    return { evidence, cleanup: restored }
  } catch (error) {
    const restored = await guard.abort("error")
    throw new Error(
      `live provider exercise failed; cleanup ${restored.ok ? "verified" : "blocked"}`,
      { cause: null }
    )
  } finally {
    privateKey = null
    provider = null
  }
}

async function main() {
  if (process.argv[2] !== "execute") {
    throw new Error("Usage: execute.mjs execute")
  }
  assertRelease(process.env)
  if (!process.env.PIPECAT_API_KEY) {
    throw new Error("PIPECAT_API_KEY is required")
  }
  let guard = null
  let pendingSignal = null
  const controlPlane = new ControlPlaneClient({
    operatorToken: process.env.PIPECAT_OPERATOR_TOKEN,
    organization: process.env.PIPECAT_ORGANIZATION,
  })
  const witness = await createFileOperatorWitness()
  const stop = (signal) => {
    const reason = `signal_${signal.toLowerCase()}`
    if (guard !== null) void guard.abort(reason)
    else pendingSignal = reason
  }
  process.once("SIGINT", () => stop("SIGINT"))
  process.once("SIGTERM", () => stop("SIGTERM"))
  await runLiveExercise({
    controlPlane,
    providerFactory: (options) => new ProviderClient(options),
    witness,
    onGuard(value) {
      guard = value
      if (pendingSignal !== null) void guard.abort(pendingSignal)
    },
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${safeError(error)}\n`)
    process.exitCode = 1
  })
}
