import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { request } from "node:http"
import { EventEmitter } from "node:events"
import { PassThrough, Writable } from "node:stream"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"

import { safeReference } from "../lib/contract.mjs"
import { createDeployCommands, runCommand } from "../live/commands.mjs"
import { createCollector } from "../live/collector.mjs"
import {
  assertSecretFreeEvidence,
  writeSecretFreeEvidence,
} from "../live/evidence.mjs"
import {
  MAX_CLOCK_SKEW_SECONDS,
  createRunSecret,
  parseCallbackEvent,
  sanitizeCallbackEvent,
  signCallback,
  signActivation,
  verifyCallback,
} from "../live/protocol.mjs"
import {
  ControlPlaneClient,
  ProviderClient,
  normalizeManifest,
  normalizeSession,
} from "../live/provider.mjs"
import {
  BASELINE,
  LIMITS,
  LiveRunState,
  abortAndRestore,
  createOperatorGuard,
  verifyRollback,
} from "../live/run-state.mjs"
import { CASES, runLiveExercise } from "../live/execute.mjs"
import { createNgrokTunnel } from "../live/tunnel.mjs"
import { runReadOnlyPreflight } from "../live/preflight.mjs"
import {
  createFileOperatorWitness,
  decodeBrowserClaims,
} from "../live/witness.mjs"

const secret = Buffer.alloc(32, 0x78).toString("base64url")
const nowSeconds = 1_800_000_000
const timestamp = String(nowSeconds)
const nonce = "a".repeat(32)

function event(overrides = {}) {
  return {
    version: 1,
    runId: "run-12345678",
    caseId: "cold_start",
    bootId: "boot-12345678",
    sessionId: "session-12345678",
    event: "registered",
    observedAt: nowSeconds,
    dailyClaims: {
      expiresAtEpochSeconds: 1_900_000_000,
      ejectAtTokenExpiry: true,
      isOwner: false,
      roomScoped: true,
    },
    ...overrides,
  }
}

function signed(body, overrides = {}) {
  const values = { secret, timestamp, nonce, body, ...overrides }
  return {
    ...values,
    signature: `v1=${signCallback(values)}`,
    nowSeconds,
  }
}

function callbackRequest({ port, body, requestNonce = nonce, signature }) {
  return new Promise((resolvePromise, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/probe-events",
        headers: {
          "content-type": "application/json",
          "content-length": body.length,
          "x-duplexd-contract-timestamp": timestamp,
          "x-duplexd-contract-nonce": requestNonce,
          "x-duplexd-contract-signature": signature,
        },
      },
      (response) => {
        response.resume()
        response.once("end", () => resolvePromise(response.statusCode))
      }
    )
    req.once("error", reject)
    req.end(body)
  })
}

test("callback HMAC binds timestamp, nonce and exact bytes", () => {
  const body = Buffer.from(JSON.stringify(event()))
  const signature = signCallback({ secret, timestamp, nonce, body })

  assert.equal(signature.length, 64)
  assert.deepEqual(
    verifyCallback({
      secret,
      timestamp,
      nonce,
      signature: `v1=${signature}`,
      body,
      nowSeconds,
    }),
    { ok: true }
  )
  for (const changed of [
    { timestamp: String(nowSeconds + 1) },
    { nonce: "b".repeat(32) },
    { body: Buffer.concat([body, Buffer.from(" ")]) },
  ]) {
    assert.deepEqual(verifyCallback({ ...signed(body), ...changed }), {
      ok: false,
      reason: "invalid_signature",
    })
  }
})

test("activation HMAC binds the exact run, callback URL and probe configuration", () => {
  const config = {
    version: 1,
    runId: "run-12345678",
    caseId: "cold_start",
    bootId: "boot-12345678",
    mode: "register_join_wait",
    callbackUrl: "https://collector.example/probe-events",
  }
  const signature = signActivation({ secret, config })
  assert.match(signature, /^[a-f0-9]{64}$/u)
  for (const changed of [
    { runId: "run-other-12345" },
    { callbackUrl: "https://attacker.example/probe-events" },
    { caseId: "hung_runtime" },
    { bootId: "boot-other-1234" },
    { mode: "no_register_join_wait" },
  ]) {
    assert.notEqual(
      signActivation({ secret, config: { ...config, ...changed } }),
      signature
    )
  }
})

test("callback verification rejects malformed, expired and wrongly sized secrets", () => {
  const body = Buffer.from("{}")
  assert.deepEqual(
    verifyCallback({ ...signed(body), timestamp: "not-a-time" }),
    { ok: false, reason: "invalid_timestamp" }
  )
  assert.deepEqual(
    verifyCallback({
      ...signed(body),
      timestamp: String(nowSeconds - MAX_CLOCK_SKEW_SECONDS - 1),
    }),
    { ok: false, reason: "expired_timestamp" }
  )
  assert.deepEqual(verifyCallback({ ...signed(body), nonce: "short" }), {
    ok: false,
    reason: "invalid_nonce",
  })
  assert.deepEqual(verifyCallback({ ...signed(body), signature: "v1=bad" }), {
    ok: false,
    reason: "invalid_signature",
  })
  assert.throws(
    () => signCallback({ secret: "too-short", timestamp, nonce, body }),
    /exactly 32 bytes/u
  )
  assert.equal(Buffer.from(createRunSecret(), "base64url").length, 32)
})

test("callback event parsing enforces allowlists and shape", () => {
  const options = {
    runId: "run-12345678",
    caseIds: new Set(["cold_start"]),
  }
  assert.deepEqual(
    parseCallbackEvent(Buffer.from(JSON.stringify(event())), options),
    event()
  )
  for (const invalid of [
    "not-json",
    JSON.stringify([]),
    JSON.stringify(event({ version: 2 })),
    JSON.stringify(event({ runId: "other-run" })),
    JSON.stringify(event({ caseId: "other-case" })),
    JSON.stringify(event({ bootId: "short" })),
    JSON.stringify(event({ sessionId: "short" })),
    JSON.stringify(event({ event: "arbitrary" })),
    JSON.stringify(event({ observedAt: 1.5 })),
    JSON.stringify(event({ dailyClaims: undefined })),
    JSON.stringify(event({ dailyClaims: {} })),
    JSON.stringify(
      event({
        dailyClaims: {
          ...event().dailyClaims,
          expiresAtEpochSeconds: 1.5,
        },
      })
    ),
    JSON.stringify(
      event({
        dailyClaims: {
          ...event().dailyClaims,
          ejectAtTokenExpiry: "true",
        },
      })
    ),
    JSON.stringify(
      event({ dailyClaims: { ...event().dailyClaims, isOwner: 0 } })
    ),
    JSON.stringify(
      event({ dailyClaims: { ...event().dailyClaims, roomScoped: "yes" } })
    ),
  ]) {
    assert.throws(() => parseCallbackEvent(Buffer.from(invalid), options))
  }
})

test("callback sanitization hashes raw identifiers and keeps only selected claims", () => {
  const raw = event({
    dailyClaims: {
      expiresAtEpochSeconds: 1_900_000_000,
      ejectAtTokenExpiry: true,
      isOwner: false,
      roomScoped: true,
      private_key: "credential-canary",
    },
  })
  const sanitized = sanitizeCallbackEvent(raw)
  const serialized = JSON.stringify(sanitized)

  assert.match(sanitized.bootId, /^sha256:[a-f0-9]{64}$/u)
  assert.match(sanitized.sessionRef, /^sha256:[a-f0-9]{64}$/u)
  assert.equal(sanitized.dailyClaims.roomScoped, true)
  for (const canary of [raw.bootId, raw.sessionId, "credential-canary"]) {
    assert.equal(serialized.includes(canary), false)
  }
})

test("collector accepts exact duplicate idempotently but rejects nonce replay and conflict", async (t) => {
  const collector = createCollector({
    secret,
    runId: "run-12345678",
    caseIds: ["cold_start"],
    now: () => nowSeconds * 1_000,
  })
  const { port } = await collector.listen()
  t.after(() => collector.close())
  const body = Buffer.from(JSON.stringify(event()))

  const firstNonce = "1".repeat(32)
  const firstSignature = `v1=${signCallback({
    secret,
    timestamp,
    nonce: firstNonce,
    body,
  })}`
  assert.equal(
    await callbackRequest({
      port,
      body,
      requestNonce: firstNonce,
      signature: firstSignature,
    }),
    204
  )
  assert.equal(
    await callbackRequest({
      port,
      body,
      requestNonce: firstNonce,
      signature: firstSignature,
    }),
    401
  )

  const retryNonce = "2".repeat(32)
  assert.equal(
    await callbackRequest({
      port,
      body,
      requestNonce: retryNonce,
      signature: `v1=${signCallback({
        secret,
        timestamp,
        nonce: retryNonce,
        body,
      })}`,
    }),
    204
  )

  const conflictBody = Buffer.from(
    JSON.stringify(event({ observedAt: nowSeconds + 1 }))
  )
  assert.equal(
    await callbackRequest({
      port,
      body: conflictBody,
      requestNonce: retryNonce,
      signature: `v1=${signCallback({
        secret,
        timestamp,
        nonce: retryNonce,
        body: conflictBody,
      })}`,
    }),
    401
  )
  const conflictNonce = "3".repeat(32)
  assert.equal(
    await callbackRequest({
      port,
      body: conflictBody,
      requestNonce: conflictNonce,
      signature: `v1=${signCallback({
        secret,
        timestamp,
        nonce: conflictNonce,
        body: conflictBody,
      })}`,
    }),
    409
  )

  assert.equal(
    collector.rawEvent("boot-12345678", "registered").observedAt,
    nowSeconds
  )
  assert.equal(collector.sanitizedEvents().length, 1)
})

function timers() {
  const scheduled = []
  const cancelled = []
  return {
    scheduled,
    cancelled,
    schedule(callback, milliseconds) {
      const timer = { callback, milliseconds, unrefCalled: false }
      timer.unref = () => {
        timer.unrefCalled = true
      }
      scheduled.push(timer)
      return timer
    },
    cancel(timer) {
      cancelled.push(timer)
    },
  }
}

test("LiveRunState enforces concurrency, six starts, timers and raw-id lifecycle", () => {
  const clock = timers()
  const state = new LiveRunState(clock)
  const first = state.beginCase("case-1")
  const startupTimer = first.startupTimer
  assert.deepEqual(
    clock.scheduled.map((timer) => timer.milliseconds),
    [LIMITS.startupSeconds * 1_000, LIMITS.operatorContainmentSeconds * 1_000]
  )
  assert.ok(clock.scheduled.every((timer) => timer.unrefCalled))
  assert.throws(() => state.beginCase("case-concurrent"), /concurrency/u)

  state.recordOperatorWitness("case-1", "session-raw-1")
  state.recordStart("case-1", "session-raw-1")
  state.recordRegistration("case-1", "session-raw-1")
  state.markReady("case-1")
  assert.equal(clock.cancelled.includes(startupTimer), true)
  assert.equal(first.startupTimer, null)
  const result = state.finishCase("case-1", { billedMinutes: 12 })
  assert.match(result.sessionRef, /^sha256:/u)
  assert.equal(JSON.stringify(result).includes("session-raw-1"), false)
  assert.deepEqual(state.emergencySessionIds(), [])
  assert.deepEqual(state.counters(), {
    started: 1,
    active: 0,
    billedMinutes: 12,
    aborted: false,
  })

  const witnessOnly = new LiveRunState()
  witnessOnly.beginCase("lost-response")
  witnessOnly.recordOperatorWitness("lost-response", "operator-only-session")
  assert.deepEqual(witnessOnly.emergencySessionIds(), ["operator-only-session"])
  witnessOnly.recordRegistration("lost-response", "operator-only-session")
  assert.equal(
    witnessOnly.finishCase("lost-response", { billedMinutes: 1 }).sessionRef,
    safeReference("operator-only-session")
  )

  for (let index = 2; index <= LIMITS.maxStarts; index += 1) {
    const caseId = `case-${index}`
    state.beginCase(caseId)
    state.finishCase(caseId, { billedMinutes: 0 })
  }
  assert.throws(() => state.beginCase("case-7"), /six-session/u)
})

test("LiveRunState aborts on timers, correlation mismatch and billing violations", () => {
  const startupClock = timers()
  const startupState = new LiveRunState(startupClock)
  const callbacks = []
  startupState.beginCase("startup", {
    onStartupTimeout: (caseId) => callbacks.push(`startup:${caseId}`),
    onWholeTimeout: (caseId) => callbacks.push(`whole:${caseId}`),
  })
  startupClock.scheduled[0].callback()
  assert.deepEqual(callbacks, ["startup:startup"])
  assert.equal(startupState.counters().aborted, true)
  assert.throws(() => startupState.beginCase("later"), /aborted/u)

  const mismatch = new LiveRunState(timers())
  mismatch.beginCase("mismatch")
  mismatch.recordStart("mismatch", "session-a")
  assert.throws(
    () => mismatch.recordRegistration("mismatch", "session-b"),
    /does not match/u
  )

  const billed = new LiveRunState(timers())
  billed.beginCase("billed")
  assert.throws(
    () => billed.finishCase("billed", { billedMinutes: 12.01 }),
    /per-session/u
  )
  assert.equal(billed.counters().aborted, true)
})

test("abort cleanup is ordered, deduplicated and continues through errors", async () => {
  const state = new LiveRunState(timers())
  state.beginCase("known")
  state.recordStart("known", "same-session")
  state.recordRegistration("known", "same-session")
  const order = []

  const result = await abortAndRestore({
    state,
    stopSession: async (sessionId) => {
      order.push(`stop:${sessionId}`)
      throw new Error("stop provider-body-canary credential-canary")
    },
    restoreBaseline: async () => {
      order.push("restore")
    },
    revokePrivateKey: async () => {
      order.push("revoke")
      throw new Error("revoke provider-body-canary credential-canary")
    },
    deleteProbeSecretSet: async () => {
      order.push("delete-secret-set")
    },
    readback: async () => {
      order.push("readback")
      return { manifest: BASELINE, sessions: [], keys: [], secretSets: [] }
    },
  })

  assert.deepEqual(order, [
    "stop:same-session",
    "restore",
    "revoke",
    "delete-secret-set",
    "readback",
  ])
  assert.equal(result.ok, false)
  assert.equal(result.verification.ok, true)
  assert.deepEqual(result.cleanupErrors, [
    "exact-session stop failed",
    "private-key revocation failed",
  ])
  const serialized = JSON.stringify(result)
  assert.equal(serialized.includes("provider-body-canary"), false)
  assert.equal(serialized.includes("credential-canary"), false)
})

test("operator guard invokes one cleanup with the first abort reason", async (t) => {
  await t.test("timer callbacks report their exact reason once", async () => {
    const clock = timers()
    const reasons = []
    const guard = createOperatorGuard({
      state: new LiveRunState(clock),
      cleanup: async (reason) => reasons.push(reason),
    })
    guard.beginCase("timed")

    clock.scheduled[0].callback()
    clock.scheduled[1].callback()
    await guard.cleanupResult()

    assert.deepEqual(reasons, ["startup_timeout"])
    assert.equal(guard.state.counters().aborted, true)
  })

  await t.test("start guard rejection reports one cleanup", async () => {
    const reasons = []
    const guard = createOperatorGuard({
      state: new LiveRunState(timers()),
      cleanup: async (reason) => reasons.push(reason),
    })
    guard.beginCase("active")
    assert.throws(() => guard.beginCase("concurrent"), /concurrency/u)
    assert.throws(() => guard.beginCase("after-abort"), /aborted/u)
    await guard.cleanupResult()

    assert.deepEqual(reasons, ["start_guard_rejected"])
  })

  await t.test("billing rejection reports one cleanup", async () => {
    const reasons = []
    const guard = createOperatorGuard({
      state: new LiveRunState(timers()),
      cleanup: async (reason) => reasons.push(reason),
    })
    guard.beginCase("billing")
    assert.throws(
      () => guard.finishCase("billing", { billedMinutes: 12.01 }),
      /per-session/u
    )
    assert.throws(
      () => guard.finishCase("billing", { billedMinutes: 12.02 }),
      /per-session/u
    )
    await guard.cleanupResult()

    assert.deepEqual(reasons, ["billing_guard_rejected"])
  })

  await t.test("manual abort keeps the caller's reason", async () => {
    const reasons = []
    const guard = createOperatorGuard({
      state: new LiveRunState(timers()),
      cleanup: async (reason) => reasons.push(reason),
    })
    const first = guard.abort("operator_cancelled")
    const second = guard.abort("later_reason")
    assert.equal(first, second)
    await first
    assert.deepEqual(reasons, ["operator_cancelled"])
  })
})

test("rollback verification requires the exact pinned baseline", async (t) => {
  assert.match(BASELINE.deploymentId, /^[0-9a-f-]{36}$/u)
  assert.match(BASELINE.buildId, /^[0-9a-f-]{36}$/u)
  assert.deepEqual(
    verifyRollback({
      manifest: { ...BASELINE },
      sessions: [],
      keys: [],
      secretSets: [],
    }),
    { ok: true, errors: [] }
  )
  assert.equal(
    verifyRollback({
      manifest: { ...BASELINE, deploymentId: "new-redeploy-id" },
      sessions: [],
      keys: [],
      secretSets: [],
    }).ok,
    true,
    "redeploy may allocate a new deployment ID"
  )
  const mutations = [
    ["agentName", "other-agent", "agent mismatch"],
    ["buildId", "other-build", "build mismatch"],
    ["imageDigest", "sha256:bad", "image digest mismatch"],
    ["minAgents", 1, "scaling mismatch"],
    ["maxAgents", 1, "scaling mismatch"],
  ]
  for (const [field, value, message] of mutations) {
    await t.test(field, () => {
      const result = verifyRollback({
        manifest: { ...BASELINE, [field]: value },
        sessions: [],
        keys: [],
        secretSets: [],
      })
      assert.equal(result.ok, false)
      assert.match(result.errors.join("\n"), new RegExp(message, "u"))
    })
  }
  assert.equal(
    verifyRollback({
      manifest: { ...BASELINE, maxSessionDurationSeconds: 600 },
      sessions: [],
      keys: [],
    }).ok,
    false
  )
  assert.equal(
    verifyRollback({
      manifest: BASELINE,
      sessions: [{}],
      keys: [],
      secretSets: [],
    }).ok,
    false
  )
  assert.equal(
    verifyRollback({
      manifest: BASELINE,
      sessions: [],
      keys: [{ name: "Stage A provider proof", type: "public" }],
      secretSets: [],
    }).ok,
    false
  )
  assert.equal(
    verifyRollback({
      manifest: BASELINE,
      sessions: [],
      keys: [{ name: "unrelated", type: "private" }],
      secretSets: [],
    }).ok,
    false
  )
  assert.equal(
    verifyRollback({
      manifest: BASELINE,
      sessions: [],
      keys: [],
      secretSets: [{ name: "duplexd-provider-proof", type: "user" }],
    }).ok,
    false
  )
})

function jsonResponse(status, value) {
  return {
    status,
    async json() {
      return value
    },
  }
}

test("ProviderClient emits exact start and management request shapes", async () => {
  const calls = []
  const session = {
    sessionId: "session-123",
    deploymentId: "deployment-123",
    createdAt: "2026-09-21T00:00:00.000Z",
    endedAt: "2026-09-21T00:01:00.000Z",
    updatedAt: "2026-09-21T00:01:01.000Z",
    completionStatus: "stopped",
    resourceMetrics: { sampleCount: 2, timeseries: [{ t: 0 }, { t: 60 }] },
  }
  const manifest = {
    serviceName: "duplexd-agent",
    activeDeployment: {
      id: "deployment-123",
      build: { id: "build-123", image: { digest: "sha256:image" } },
      autoScaling: { minAgents: 0, maxAgents: 1 },
      secretSetName: "duplexd-provider-proof",
      maxSessionDurationSeconds: 600,
    },
  }
  const responses = [
    jsonResponse(200, {
      sessionId: "session-123",
      dailyRoom: "https://daily.example/room",
      dailyToken: "daily-token",
    }),
    jsonResponse(200, { stopped: true }),
    jsonResponse(404, { detail: "not found" }),
    jsonResponse(200, { sessions: [session] }),
    jsonResponse(200, { session }),
    jsonResponse(200, { service: manifest }),
    jsonResponse(200, { maxSessionDurationSeconds: 600 }),
  ]
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options })
    return responses.shift()
  }
  const client = new ProviderClient({
    publicKey: " public-key ",
    privateKey: " private-key ",
    fetchImpl,
  })
  const probeBody = { providerContractProbe: { version: 1 } }

  assert.equal(
    (
      await client.start({
        body: probeBody,
        expiresAtEpochSeconds: 1_900_000_000,
      })
    ).sessionId,
    "session-123"
  )
  assert.equal((await client.stop("session/123")).status, 200)
  assert.equal((await client.stop("session/123")).status, 404)
  assert.equal((await client.sessions("running"))[0].billedMinutes, 1)
  assert.equal((await client.session("session-123")).sessionId, "session-123")
  assert.equal(
    (await client.readManifest()).secretSet,
    "duplexd-provider-proof"
  )
  await client.setMaxSessionDuration(600)

  assert.equal(
    calls[0].url,
    "https://api.pipecat.daily.co/v1/public/duplexd-agent/start"
  )
  assert.equal(calls[0].options.method, "POST")
  assert.equal(calls[0].options.headers.authorization, "Bearer public-key")
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    createDailyRoom: true,
    transport: "daily",
    dailyRoomProperties: {
      exp: 1_900_000_000,
      eject_at_room_exp: true,
    },
    dailyMeetingTokenProperties: {
      exp: 1_900_000_000,
      eject_at_token_exp: true,
      is_owner: false,
    },
    body: probeBody,
  })
  assert.equal(
    calls[1].url,
    "https://api.pipecat.daily.co/v1/agents/duplexd-agent/sessions/session%2F123"
  )
  assert.equal(calls[1].options.method, "DELETE")
  assert.equal(calls[1].options.headers.authorization, "Bearer private-key")
  assert.equal(
    calls[3].url,
    "https://api.pipecat.daily.co/v1/agents/duplexd-agent/sessions?status=running&limit=100"
  )
  assert.equal(
    calls[4].url,
    "https://api.pipecat.daily.co/v1/agents/duplexd-agent/sessions/session-123"
  )
  assert.equal(calls[4].options.method, "GET")
  assert.equal(
    calls[5].url,
    "https://api.pipecat.daily.co/v1/agents/duplexd-agent"
  )
  assert.equal(calls[6].options.method, "POST")
  assert.deepEqual(JSON.parse(calls[6].options.body), {
    maxSessionDuration: 600,
  })
})

test("provider normalizers reject mismatched or malformed exact-session data", () => {
  assert.deepEqual(
    normalizeManifest({
      body: {
        name: "duplexd-agent",
        deployment: {
          deploymentId: "deployment-1",
          buildId: "build-1",
          imageDigest: "sha256:image",
          minAgents: 0,
          maxAgents: 3,
          secretSet: "duplexd-agent-secrets",
        },
      },
    }),
    {
      agentName: "duplexd-agent",
      deploymentId: "deployment-1",
      buildId: "build-1",
      imageDigest: "sha256:image",
      minAgents: 0,
      maxAgents: 3,
      secretSet: "duplexd-agent-secrets",
    }
  )
  assert.deepEqual(
    normalizeManifest({
      body: {
        name: "duplexd-agent",
        activeDeploymentId: "deployment-2",
        buildId: "build-2",
        autoScaling: { minReplicas: 0, maxReplicas: 3 },
        secretSet: "duplexd-agent-secrets",
        maxSessionDuration: 600,
        deployment: {
          manifest: {
            spec: {
              image: `registry.example/duplexd@sha256:${"a".repeat(64)}`,
            },
          },
        },
      },
    }),
    {
      agentName: "duplexd-agent",
      deploymentId: "deployment-2",
      buildId: "build-2",
      imageDigest: `sha256:${"a".repeat(64)}`,
      minAgents: 0,
      maxAgents: 3,
      secretSet: "duplexd-agent-secrets",
      maxSessionDurationSeconds: 600,
    }
  )
  const base = {
    id: "session-1",
    deploymentId: "deployment-1",
    createdAt: "2026-09-21T00:00:00.000Z",
    endedAt: null,
    updatedAt: "2026-09-21T00:00:01.000Z",
  }
  assert.equal(
    normalizeSession({ body: base }, "session-1").billedMinutes,
    null
  )
  assert.throws(
    () => normalizeSession(base, "other-session"),
    /does not match/u
  )
  assert.throws(() => normalizeSession({ ...base, endedAt: 12 }), /endedAt/u)
  assert.throws(
    () => normalizeSession({ ...base, createdAt: "not-a-date" }),
    /timestamps/u
  )
})

test("ControlPlaneClient uses exact management endpoints and normalized request bodies", async () => {
  const calls = []
  const session = {
    id: "session-1",
    deploymentId: "deployment-1",
    createdAt: "2026-09-21T00:00:00.000Z",
    endedAt: null,
    updatedAt: "2026-09-21T00:00:01.000Z",
  }
  const responses = [
    jsonResponse(200, {
      name: "duplexd-agent",
      deploymentId: "deployment-1",
      buildId: "build-1",
      imageDigest: "sha256:image",
      minAgents: 0,
      maxAgents: 3,
      secretSet: "duplexd-agent-secrets",
    }),
    jsonResponse(200, { sessions: [session] }),
    jsonResponse(200, {
      apiKey: {
        apiKeyId: "key-1",
        apiKey: "private-value",
        name: "proof",
        type: "private",
      },
    }),
    jsonResponse(200, {
      keys: [{ apiKeyId: "key-1", name: "proof", type: "private" }],
    }),
    jsonResponse(204, null),
    jsonResponse(200, {}),
    jsonResponse(200, {}),
    jsonResponse(200, {}),
    jsonResponse(200, {}),
    jsonResponse(200, { sets: [{ name: "probe", type: "user" }] }),
    jsonResponse(404, {}),
    jsonResponse(200, { restored: true }),
  ]
  const client = new ControlPlaneClient({
    operatorToken: " operator-secret ",
    organization: "org/name",
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options })
      return responses.shift()
    },
  })
  await client.readManifest()
  await client.listSessions()
  assert.equal((await client.createPrivateKey("proof")).key, "private-value")
  await client.listKeys()
  await client.revokeKey("key/1")
  await client.createProbeSecretSet({
    PROVIDER_CONTRACT_PROBE_ENABLED: "stage-a-provider-proof",
    PROVIDER_CONTRACT_PROBE_RUN_ID: "run-12345678",
    PROVIDER_CONTRACT_PROBE_CALLBACK_URL: "https://safe.example/probe-events",
    PROVIDER_CONTRACT_PROBE_ACTIVATION_SECRET: "activation-secret",
  })
  await client.listSecretSets()
  await client.deleteProbeSecretSet()
  await client.restoreBaseline(BASELINE)

  const origin = "https://api.pipecat.daily.co/v1/organizations/org%2Fname"
  assert.deepEqual(
    calls.map(({ url, options }) => [url, options.method]),
    [
      [`${origin}/services/duplexd-agent`, "GET"],
      [`${origin}/services/duplexd-agent/sessions`, "GET"],
      [`${origin}/apiKeys`, "POST"],
      [`${origin}/apiKeys`, "GET"],
      [`${origin}/apiKeys/key%2F1`, "DELETE"],
      [`${origin}/secrets/duplexd-provider-proof`, "PUT"],
      [`${origin}/secrets/duplexd-provider-proof`, "PUT"],
      [`${origin}/secrets/duplexd-provider-proof`, "PUT"],
      [`${origin}/secrets/duplexd-provider-proof`, "PUT"],
      [`${origin}/secrets`, "GET"],
      [`${origin}/secrets/duplexd-provider-proof`, "DELETE"],
      [`${origin}/services`, "PUT"],
    ]
  )
  assert.deepEqual(JSON.parse(calls[2].options.body), {
    name: "proof",
    type: "private",
  })
  assert.deepEqual(
    calls.slice(5, 9).map(({ options }) => JSON.parse(options.body)),
    [
      {
        name: "duplexd-provider-proof",
        isImagePullSecret: false,
        secretKey: "PROVIDER_CONTRACT_PROBE_ENABLED",
        secretValue: "stage-a-provider-proof",
      },
      {
        name: "duplexd-provider-proof",
        isImagePullSecret: false,
        secretKey: "PROVIDER_CONTRACT_PROBE_RUN_ID",
        secretValue: "run-12345678",
      },
      {
        name: "duplexd-provider-proof",
        isImagePullSecret: false,
        secretKey: "PROVIDER_CONTRACT_PROBE_CALLBACK_URL",
        secretValue: "https://safe.example/probe-events",
      },
      {
        name: "duplexd-provider-proof",
        isImagePullSecret: false,
        secretKey: "PROVIDER_CONTRACT_PROBE_ACTIVATION_SECRET",
        secretValue: "activation-secret",
      },
    ]
  )
  assert.deepEqual(JSON.parse(calls[11].options.body), {
    serviceName: "duplexd-agent",
    buildId: BASELINE.buildId,
    secretSet: BASELINE.secretSet,
    autoScaling: { minAgents: 0, maxAgents: 3 },
    agentProfile: "agent-1x",
  })
  assert.ok(
    calls.every(
      ({ options }) =>
        options.headers.authorization === "Bearer operator-secret"
    )
  )
})

test("ControlPlaneClient normalizes OAuth key buckets and selects the exact private proof key for revocation", async () => {
  const calls = []
  const responses = [
    jsonResponse(200, {
      public: [
        {
          id: "public-key-id",
          metadata: { name: "Existing public key" },
          type: "public",
        },
      ],
      private: [
        {
          id: "private/key-id",
          metadata: { name: "Stage A provider proof" },
          type: "private",
        },
      ],
    }),
    jsonResponse(204, null),
  ]
  const client = new ControlPlaneClient({
    operatorToken: "operator-secret",
    organization: "org-name",
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options })
      return responses.shift()
    },
  })

  const keys = await client.listKeys()
  assert.deepEqual(keys, [
    { id: "public-key-id", name: "Existing public key", type: "public" },
    {
      id: "private/key-id",
      name: "Stage A provider proof",
      type: "private",
    },
  ])
  const temporary = keys.filter(
    (key) => key.name === "Stage A provider proof" && key.type === "private"
  )
  assert.equal(temporary.length, 1)
  await client.revokeKey(temporary[0].id)
  assert.equal(
    calls[1].url,
    "https://api.pipecat.daily.co/v1/organizations/org-name/apiKeys/private%2Fkey-id"
  )
  assert.equal(calls[1].options.method, "DELETE")
})

test("read-only preflight accepts the sanitized real control-plane response shapes", async () => {
  const calls = []
  const responses = [
    jsonResponse(200, {
      body: {
        name: BASELINE.agentName,
        activeDeploymentId: BASELINE.deploymentId,
        autoScaling: { minReplicas: 0, maxReplicas: 3 },
        activeSessionCount: 0,
        deployment: {
          id: BASELINE.deploymentId,
          buildId: BASELINE.buildId,
          manifest: {
            spec: { envFromSecretNames: [BASELINE.secretSet] },
          },
        },
      },
    }),
    jsonResponse(200, {
      build: { id: BASELINE.buildId, imageDigest: BASELINE.imageDigest },
    }),
    jsonResponse(200, {
      total_count: 1,
      sessions: [
        {
          sessionId: "historical-session",
          deploymentId: BASELINE.deploymentId,
          createdAt: "2026-09-21T00:00:00.000Z",
          endedAt: "2026-09-21T00:01:00.000Z",
          updatedAt: "2026-09-21T00:01:01.000Z",
          completionStatus: "completed",
          resourceMetrics: null,
        },
      ],
    }),
    jsonResponse(200, {
      public: [
        {
          id: "existing-public-key",
          metadata: { name: "Existing public key" },
          type: "public",
        },
      ],
      private: [],
    }),
    jsonResponse(200, {
      sets: [
        {
          name: BASELINE.secretSet,
          type: "user",
          region: "sanitized-region",
          source: "user",
          status: "ready",
        },
      ],
    }),
  ]
  const client = new ControlPlaneClient({
    operatorToken: "operator-secret",
    organization: "org-name",
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options })
      return responses.shift()
    },
  })

  assert.deepEqual(await runReadOnlyPreflight(client), {
    baseline: {
      agentName: true,
      buildId: true,
      imageDigest: true,
      scaling: true,
      secretSet: true,
      durationOverrideAbsent: true,
    },
    activeSessionCount: 0,
    privateKeyCount: 0,
    temporarySecretSetAbsent: true,
    ok: true,
  })
  assert.deepEqual(
    calls.map(({ url, options }) => [url, options.method]),
    [
      [
        "https://api.pipecat.daily.co/v1/organizations/org-name/services/duplexd-agent",
        "GET",
      ],
      [
        `https://api.pipecat.daily.co/v1/organizations/org-name/builds/${BASELINE.buildId}`,
        "GET",
      ],
      [
        "https://api.pipecat.daily.co/v1/organizations/org-name/services/duplexd-agent/sessions",
        "GET",
      ],
      ["https://api.pipecat.daily.co/v1/organizations/org-name/apiKeys", "GET"],
      ["https://api.pipecat.daily.co/v1/organizations/org-name/secrets", "GET"],
    ]
  )
})

test("ProviderClient does not retry and redacts transport/provider failures", async () => {
  const credential = "credential-canary"
  const providerBody = "provider-body-canary"
  let attempts = 0
  const client = new ProviderClient({
    publicKey: credential,
    privateKey: credential,
    fetchImpl: async () => {
      attempts += 1
      return jsonResponse(500, { detail: providerBody, credential })
    },
  })
  await assert.rejects(
    client.start({ body: {}, expiresAtEpochSeconds: 1_900_000_000 }),
    (error) => {
      assert.match(error.message, /HTTP 500/u)
      assert.equal(error.message.includes(credential), false)
      assert.equal(error.message.includes(providerBody), false)
      return true
    }
  )
  assert.equal(attempts, 1)

  const failed = new ProviderClient({
    publicKey: credential,
    privateKey: credential,
    fetchImpl: async () => {
      throw new Error(`socket failed ${credential}`)
    },
  })
  await assert.rejects(failed.stop("session-canary"), (error) => {
    assert.equal(error.message, "Pipecat DELETE request failed")
    assert.equal(String(error.cause).includes(credential), false)
    return true
  })
})

test("abort cleanup restores the original secret set before deleting temporary material", async () => {
  const state = new LiveRunState(timers())
  state.beginCase("active")
  state.recordStart("active", "raw-session-canary")
  const order = []
  const result = await abortAndRestore({
    state,
    stopSession: async () => order.push("stop"),
    restoreBaseline: async () => order.push(`restore:${BASELINE.secretSet}`),
    revokePrivateKey: async () => order.push("revoke"),
    deleteProbeSecretSet: async () => order.push("delete-secret-set"),
    readback: async () => {
      order.push("readback")
      return { manifest: BASELINE, sessions: [], keys: [], secretSets: [] }
    },
  })
  assert.deepEqual(order, [
    "stop",
    `restore:${BASELINE.secretSet}`,
    "revoke",
    "delete-secret-set",
    "readback",
  ])
  assert.equal(result.ok, true)
  assert.equal(
    JSON.stringify(result.containment).includes("raw-session-canary"),
    false
  )
  assert.deepEqual(result.containment, {
    knownSessionRefs: [result.containment.knownSessionRefs[0]],
    baselineRestored: true,
    privateKeyRevoked: true,
    probeSecretSetDeleted: true,
    activeSessionRefs: [],
  })
})

test("failed baseline restore preserves the probe secret set for containment", async () => {
  const order = []
  const result = await abortAndRestore({
    state: new LiveRunState(timers()),
    stopSession: async () => order.push("stop"),
    restoreBaseline: async () => {
      order.push("restore")
      throw new Error("restore-failed")
    },
    revokePrivateKey: async () => order.push("revoke"),
    deleteProbeSecretSet: async () => order.push("delete-secret-set"),
    readback: async () => ({
      manifest: { ...BASELINE, secretSet: "duplexd-provider-proof" },
      sessions: [],
      keys: [],
      secretSets: [{ name: "duplexd-provider-proof" }],
    }),
  })
  assert.deepEqual(order, ["restore", "revoke"])
  assert.equal(result.ok, false)
  assert.equal(result.containment.baselineRestored, false)
  assert.equal(result.containment.probeSecretSetDeleted, false)
  assert.match(result.cleanupErrors.join("\n"), /deletion skipped/u)
})

test("command, tunnel and browser-claim adapters are bounded and exact", async () => {
  const spawnCalls = []
  const spawnImpl = (command, args, options) => {
    spawnCalls.push({ command, args, options })
    const child = new EventEmitter()
    queueMicrotask(() => child.emit("exit", 0, null))
    return child
  }
  await runCommand("tool", ["arg"], { cwd: "/tmp", spawnImpl })
  await createDeployCommands({
    run: async (command, args, options) =>
      spawnCalls.push({ command, args, options }),
    environment: { PIPECAT_ORGANIZATION: "test-org" },
  }).deployProbe()
  assert.equal(spawnCalls[0].command, "tool")
  assert.deepEqual(spawnCalls[0].args, ["arg"])
  assert.equal(spawnCalls[1].command, "uv")
  assert.deepEqual(spawnCalls[1].args.slice(0, 4), [
    "run",
    "pipecat",
    "cloud",
    "deploy",
  ])
  assert.ok(spawnCalls[1].args.includes("duplexd-provider-proof"))
  assert.ok(spawnCalls[1].args.includes("test-org"))
  assert.ok(spawnCalls[1].args.includes("--force"))
  assert.ok(spawnCalls[1].args.includes("--yes"))
  assert.equal(spawnCalls[1].options.timeoutMs, 10 * 60 * 1_000)

  const process = new EventEmitter()
  process.exitCode = null
  process.kill = (signal) => {
    process.exitCode = 0
    queueMicrotask(() => process.emit("exit", 0, signal))
  }
  const tunnel = createNgrokTunnel({
    spawnImpl: (...args) => {
      spawnCalls.push({ tunnel: args })
      return process
    },
    fetchImpl: async (url, options) => {
      assert.equal(url, "http://127.0.0.1:4040/api/tunnels")
      assert.ok(options.signal instanceof AbortSignal)
      return jsonResponse(200, {
        tunnels: [
          {
            public_url: "http://ignored.example",
            config: { addr: "http://127.0.0.1:43123" },
          },
          {
            public_url: "https://wrong.example/path",
            config: { addr: "http://127.0.0.1:9999" },
          },
          {
            public_url: "https://safe.example/path",
            config: { addr: "http://127.0.0.1:43123" },
          },
        ],
      })
    },
    pollDelay: async () => {},
  })
  assert.equal(await tunnel.open(43123), "https://safe.example/probe-events")
  assert.equal(tunnel.publicUrl(), "https://safe.example")
  assert.deepEqual(spawnCalls.at(-1).tunnel.slice(0, 2), [
    "ngrok",
    [
      "http",
      "http://127.0.0.1:43123",
      "--log",
      "stdout",
      "--log-format",
      "json",
    ],
  ])
  await tunnel.close()
  assert.equal(tunnel.publicUrl(), null)

  const token = `header.${Buffer.from(
    JSON.stringify({
      properties: {
        exp: 1_900_000_000,
        eject_at_token_exp: true,
        is_owner: false,
        room_name: "synthetic-room",
      },
    })
  ).toString("base64url")}.signature`
  assert.deepEqual(decodeBrowserClaims(token), {
    expiresAtEpochSeconds: 1_900_000_000,
    ejectAtTokenExpiry: true,
    isOwner: false,
    roomScoped: true,
  })
  assert.throws(() => decodeBrowserClaims("not-a-jwt"), /invalid/u)
})

test("runCommand terminates an aborted child tree and waits for its exit", async () => {
  const controller = new AbortController()
  const child = new EventEmitter()
  child.pid = 43210
  const terminations = []
  const running = runCommand("never-exits", [], {
    spawnImpl: () => child,
    signal: controller.signal,
    timeoutMs: 60_000,
    terminateImpl(value, signal) {
      assert.equal(value, child)
      terminations.push(signal)
      queueMicrotask(() => child.emit("exit", null, signal))
    },
  })
  controller.abort("operator signal")
  await assert.rejects(running, /never-exits aborted/u)
  assert.deepEqual(terminations, ["SIGTERM"])
})

test("file witness writes mode-0600 volatile material, verifies input and destroys it", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "duplexd-witness-test-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const input = new PassThrough()
  let outputText = ""
  const output = new Writable({
    write(chunk, _encoding, callback) {
      outputText += chunk.toString()
      callback()
    },
  })
  const witness = await createFileOperatorWitness({
    input,
    output,
    makeDirectory: async () => directory,
  })
  await witness.publishJoin("cold_start", {
    dailyRoom: "room-canary",
    dailyToken: "token-canary",
  })
  const joinPath = join(directory, "cold_start-join.html")
  assert.equal((await stat(joinPath)).mode & 0o777, 0o600)
  const expected = witness.expect("cold_start", "browser_joined")
  input.write("cold_start:browser_joined\n")
  assert.match(await expected, /^\d{4}-/u)
  await witness.clearCase()
  await assert.rejects(stat(joinPath))
  const containment = await witness.preserveContainment({
    reason: "cleanup-blocked",
  })
  assert.equal((await stat(containment)).mode & 0o777, 0o600)
  assert.equal(outputText.includes("token-canary"), false)
  await witness.close({ destroy: true })
  await assert.rejects(stat(directory))
})

function liveHarness({
  failRestore = false,
  failStartAt = null,
  missingUsageAt = null,
  suppressRegistrationAt = null,
  changingUsageAt = null,
} = {}) {
  const order = []
  let privateKeyPresent = false
  let secretSetPresent = false
  let probeActive = false
  const sessions = new Map()
  const callbacks = new Map()
  const sessionReads = new Map()
  let startCount = 0
  const controlPlane = {
    async readManifest() {
      order.push("control:manifest")
      return probeActive
        ? {
            ...BASELINE,
            deploymentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            buildId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            imageDigest: `sha256:${"c".repeat(64)}`,
            maxAgents: 1,
            secretSet: "duplexd-provider-proof",
            maxSessionDurationSeconds: 600,
          }
        : BASELINE
    },
    async listSessions() {
      order.push("control:sessions")
      return [...sessions.entries()]
        .filter(([, session]) => session.active)
        .map(([sessionId]) => ({
          sessionId,
          deploymentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          endedAt: null,
        }))
    },
    async listKeys() {
      order.push("control:keys")
      return privateKeyPresent
        ? [{ id: "key-temp", name: "Stage A provider proof", type: "private" }]
        : []
    },
    async listSecretSets() {
      order.push("control:secret-sets")
      return secretSetPresent
        ? [{ name: "duplexd-provider-proof", type: "user" }]
        : []
    },
    async createProbeSecretSet(values) {
      order.push("create:secret-set")
      assert.equal(
        values.PROVIDER_CONTRACT_PROBE_ENABLED,
        "stage-a-provider-proof"
      )
      assert.equal(values.PROVIDER_CONTRACT_PROBE_RUN_ID, "run-12345678")
      assert.equal(
        values.PROVIDER_CONTRACT_PROBE_CALLBACK_URL,
        "https://safe.example/probe-events"
      )
      secretSetPresent = true
    },
    async createPrivateKey(name) {
      order.push("create:key")
      privateKeyPresent = true
      return { id: "key-temp", key: "private-canary", name, type: "private" }
    },
    async revokeKey(id) {
      order.push(`revoke:${id}`)
      privateKeyPresent = false
    },
    async restoreBaseline(value) {
      order.push(`restore:${value.secretSet}`)
      if (failRestore) throw new Error("restore-canary")
      probeActive = false
    },
    async deleteProbeSecretSet() {
      order.push("delete:secret-set")
      secretSetPresent = false
    },
  }
  const provider = {
    async readManifest() {
      order.push("provider:manifest")
      return {
        ...BASELINE,
        deploymentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        buildId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        imageDigest: `sha256:${"c".repeat(64)}`,
        maxAgents: 1,
        secretSet: "duplexd-provider-proof",
        maxSessionDurationSeconds: 600,
      }
    },
    async setMaxSessionDuration(seconds) {
      order.push(`duration:${seconds}`)
      probeActive = true
    },
    async start({ body }) {
      startCount += 1
      const probe = body.providerContractProbe
      const sessionId = `session-${startCount}-12345678`
      sessions.set(sessionId, { stops: 0, active: true })
      if (suppressRegistrationAt !== startCount) {
        callbacks.set(`${probe.bootId}:registered`, {
          ...event({
            caseId: probe.caseId,
            bootId: probe.bootId,
            sessionId,
            event: "registered",
            dailyClaims: {
              ...event().dailyClaims,
              expiresAtEpochSeconds: 1_800_000_300,
            },
          }),
        })
      }
      callbacks.set(`${probe.bootId}:agent_joined`, {
        ...event({
          caseId: probe.caseId,
          bootId: probe.bootId,
          sessionId,
          event: "agent_joined",
          dailyClaims: {
            ...event().dailyClaims,
            expiresAtEpochSeconds: 1_800_000_300,
          },
        }),
      })
      callbacks.set(`${probe.bootId}:agent_left`, {
        ...event({
          caseId: probe.caseId,
          bootId: probe.bootId,
          sessionId,
          event: "agent_left",
          dailyClaims: {
            ...event().dailyClaims,
            expiresAtEpochSeconds: 1_800_000_300,
          },
        }),
      })
      const token = `header.${Buffer.from(
        JSON.stringify({
          properties: {
            exp: 1_800_000_300,
            eject_at_token_exp: true,
            is_owner: false,
            room_name: "synthetic-room",
          },
        })
      ).toString("base64url")}.signature`
      if (failStartAt === startCount)
        throw new Error("start-ambiguous-canary private-canary")
      return {
        sessionId,
        dailyRoom: "https://daily.example/room",
        dailyToken: token,
      }
    },
    async stop(sessionId) {
      order.push(`stop:${sessionId}`)
      const current = sessions.get(sessionId)
      current.stops += 1
      current.active = false
      return { status: current.stops === 1 ? 200 : 404 }
    },
    async session(sessionId) {
      const current = sessions.get(sessionId)
      if (current !== undefined) current.active = false
      const reads = (sessionReads.get(sessionId) ?? 0) + 1
      sessionReads.set(sessionId, reads)
      const changing =
        sessionId === `session-${changingUsageAt}-12345678` && reads < 3
      return {
        sessionId,
        endedAt: "2027-01-15T08:00:01.000Z",
        updatedAt: changing
          ? `2027-01-15T08:00:0${reads}.000Z`
          : "2027-01-15T08:00:03.000Z",
        completionStatus: "stopped",
        resourceMetrics:
          sessionId === `session-${missingUsageAt}-12345678`
            ? null
            : {
                sampleCount: changing ? reads : 3,
                timeseries: [{ t: 0 }, { t: changing ? reads : 60 }],
              },
        billedMinutes: 0.01,
      }
    },
  }
  const collector = {
    async listen() {
      return { port: 43123 }
    },
    async close() {
      order.push("close:collector")
    },
    async waitFor(bootId, callbackEvent) {
      return callbacks.get(`${bootId}:${callbackEvent}`) ?? null
    },
  }
  const tunnel = {
    async open(port) {
      assert.equal(port, 43123)
      return "https://safe.example/probe-events"
    },
    async close() {
      order.push("close:tunnel")
    },
  }
  const containment = []
  const witness = {
    async publishJoin() {
      order.push("witness:publish")
    },
    async expect(caseId, witnessEvent) {
      order.push(`witness:${caseId}:${witnessEvent}`)
      return "2027-01-15T08:00:00.000Z"
    },
    async clearCase() {
      order.push("witness:clear")
    },
    async preserveContainment(value) {
      containment.push(value)
      return "/volatile/containment.json"
    },
    async close({ destroy }) {
      order.push(`witness:close:${destroy}`)
    },
  }
  return {
    order,
    controlPlane,
    provider,
    collector,
    tunnel,
    witness,
    containment,
    expireSessions() {
      for (const session of sessions.values()) session.active = false
    },
    sessionReadCount(sessionId) {
      return sessionReads.get(sessionId) ?? 0
    },
    get startCount() {
      return startCount
    },
  }
}

function liveEnvironment(path = "/tmp/provider-contract-evidence.json") {
  return {
    PROVIDER_CONTRACT_LIVE_RELEASE: "stage-a-provider-proof-live-release",
    PROVIDER_CONTRACT_SECRET_SET_APPROVED: "duplexd-provider-proof",
    PROVIDER_CONTRACT_RUN_ID: "run-12345678",
    PROVIDER_CONTRACT_EVIDENCE_PATH: path,
    PIPECAT_API_KEY: "public-canary",
  }
}

test("live runner refuses missing release and credential gates before mutation", async () => {
  for (const environment of [
    {},
    { PROVIDER_CONTRACT_LIVE_RELEASE: "stage-a-provider-proof-live-release" },
    {
      PROVIDER_CONTRACT_LIVE_RELEASE: "stage-a-provider-proof-live-release",
      PROVIDER_CONTRACT_SECRET_SET_APPROVED: "duplexd-provider-proof",
      PROVIDER_CONTRACT_RUN_ID: "run-12345678",
      PROVIDER_CONTRACT_EVIDENCE_PATH: "/tmp/unused",
    },
  ]) {
    const harness = liveHarness()
    await assert.rejects(
      runLiveExercise({
        environment,
        controlPlane: harness.controlPlane,
        providerFactory: () => harness.provider,
        collectorFactory: () => harness.collector,
        tunnel: harness.tunnel,
        witness: harness.witness,
      }),
      /release|approval|PIPECAT_API_KEY/u
    )
    assert.deepEqual(harness.order, [])
  }
})

test("executable entry point rejects a missing release before allocating live resources", () => {
  const executable = resolve("scripts/provider-contract/live/execute.mjs")
  const result = spawnSync(process.execPath, [executable, "execute"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
    timeout: 2_000,
  })
  assert.equal(result.status, 1)
  assert.equal(result.signal, null)
  assert.match(result.stderr, /live provider release is not present/u)
})

test("fully injected live runner executes exactly six serial cases and sanitizes durable output", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "duplexd-live-runner-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const evidencePath = join(directory, "evidence.json")
  const harness = liveHarness()
  const result = await runLiveExercise({
    environment: liveEnvironment(evidencePath),
    controlPlane: harness.controlPlane,
    providerFactory: ({ publicKey, privateKey }) => {
      assert.equal(publicKey, "public-canary")
      assert.equal(privateKey, "private-canary")
      return harness.provider
    },
    deployCommands: {
      async deployProbe() {
        harness.order.push("deploy")
      },
    },
    collectorFactory: () => harness.collector,
    tunnel: harness.tunnel,
    witness: harness.witness,
    sleep: async () => {},
    now: () => Date.parse("2027-01-15T08:00:00.000Z"),
  })
  assert.equal(harness.startCount, CASES.length)
  assert.equal(result.evidence.cases.length, CASES.length)
  assert.equal(result.cleanup.ok, true)
  assert.ok(
    harness.order.indexOf(`restore:${BASELINE.secretSet}`) <
      harness.order.indexOf("delete:secret-set")
  )
  const serialized = await readFile(evidencePath, "utf8")
  for (const canary of [
    "private-canary",
    "public-canary",
    "daily.example",
    "session-1-12345678",
  ]) {
    assert.equal(serialized.includes(canary), false)
  }
})

test("ambiguous start failure cleans up and redacts volatile credentials from the surfaced error", async () => {
  const harness = liveHarness({ failStartAt: 1 })
  await assert.rejects(
    runLiveExercise({
      environment: liveEnvironment(),
      controlPlane: harness.controlPlane,
      providerFactory: () => harness.provider,
      deployCommands: { async deployProbe() {} },
      collectorFactory: () => harness.collector,
      tunnel: harness.tunnel,
      witness: harness.witness,
      sleep: async () => {},
      now: () => Date.parse("2027-01-15T08:00:00.000Z"),
    }),
    (error) => {
      assert.match(error.message, /cleanup verified/u)
      assert.equal(error.message.includes("private-canary"), false)
      return true
    }
  )
  assert.ok(harness.order.includes(`restore:${BASELINE.secretSet}`))
  assert.ok(harness.order.includes("delete:secret-set"))
  assert.equal(harness.startCount, 1)
  assert.equal(
    harness.order.filter((entry) => entry === "stop:session-1-12345678").length,
    1
  )
})

test("live runner reports a fixed secret-safe operation stage", async () => {
  const harness = liveHarness()
  harness.controlPlane.createPrivateKey = async () => {
    throw new Error("private-key-stage-canary credential-canary")
  }
  await assert.rejects(
    runLiveExercise({
      environment: liveEnvironment(),
      controlPlane: harness.controlPlane,
      providerFactory: () => harness.provider,
      deployCommands: { async deployProbe() {} },
      collectorFactory: () => harness.collector,
      tunnel: harness.tunnel,
      witness: harness.witness,
      sleep: async () => {},
    }),
    (error) => {
      assert.match(error.message, /failed at private_key_create/u)
      assert.match(error.message, /cleanup verified/u)
      assert.equal(error.message.includes("stage-canary"), false)
      assert.equal(error.message.includes("credential-canary"), false)
      return true
    }
  )
})

test("ambiguous start without registration waits through the provider ceiling before zero-active restore", async () => {
  const harness = liveHarness({
    failStartAt: 1,
    suppressRegistrationAt: 1,
  })
  const sleeps = []
  await assert.rejects(
    runLiveExercise({
      environment: liveEnvironment(),
      controlPlane: harness.controlPlane,
      providerFactory: () => harness.provider,
      deployCommands: { async deployProbe() {} },
      collectorFactory: () => harness.collector,
      tunnel: harness.tunnel,
      witness: harness.witness,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds)
        if (
          milliseconds ===
          (LIMITS.providerMaxSessionSeconds - LIMITS.startupSeconds) * 1_000
        ) {
          harness.expireSessions()
        }
      },
    }),
    /cleanup verified/u
  )
  assert.equal(harness.startCount, 1)
  assert.ok(sleeps.includes(LIMITS.startupSeconds * 1_000))
  assert.ok(
    sleeps.includes(
      (LIMITS.providerMaxSessionSeconds - LIMITS.startupSeconds) * 1_000
    )
  )
  assert.ok(harness.order.includes(`restore:${BASELINE.secretSet}`))
})

test("unresolved ambiguous start preserves the probe deployment and secret set", async () => {
  const harness = liveHarness({
    failStartAt: 1,
    suppressRegistrationAt: 1,
  })
  await assert.rejects(
    runLiveExercise({
      environment: liveEnvironment(),
      controlPlane: harness.controlPlane,
      providerFactory: () => harness.provider,
      deployCommands: { async deployProbe() {} },
      collectorFactory: () => harness.collector,
      tunnel: harness.tunnel,
      witness: harness.witness,
      sleep: async () => {},
    }),
    /cleanup blocked/u
  )
  assert.equal(harness.startCount, 1)
  assert.equal(harness.order.includes(`restore:${BASELINE.secretSet}`), false)
  assert.equal(harness.order.includes("delete:secret-set"), false)
  assert.equal(harness.containment[0].containment.unknownAcceptedStart, true)
})

test("exact-session reconciliation requires two consecutive stable observations", async () => {
  const harness = liveHarness({ changingUsageAt: 1 })
  await runLiveExercise({
    environment: liveEnvironment(),
    controlPlane: harness.controlPlane,
    providerFactory: () => harness.provider,
    deployCommands: { async deployProbe() {} },
    collectorFactory: () => harness.collector,
    tunnel: harness.tunnel,
    witness: harness.witness,
    sleep: async () => {},
    now: () => Date.parse("2027-01-15T08:00:00.000Z"),
  })
  assert.equal(harness.sessionReadCount("session-1-12345678"), 4)
})

test("signal aborts a hung deploy before cleanup runs exactly once", async () => {
  const harness = liveHarness()
  let guard
  let deployAborted = 0
  await assert.rejects(
    runLiveExercise({
      environment: liveEnvironment(),
      controlPlane: harness.controlPlane,
      providerFactory: () => harness.provider,
      deployCommands: {
        deployProbe({ signal }) {
          return new Promise((resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                deployAborted += 1
                reject(new Error("deploy aborted"))
              },
              { once: true }
            )
            queueMicrotask(() => guard.abort("signal_sigint"))
          })
        },
      },
      collectorFactory: () => harness.collector,
      tunnel: harness.tunnel,
      witness: harness.witness,
      onGuard(value) {
        guard = value
      },
    }),
    /cleanup verified/u
  )
  assert.equal(deployAborted, 1)
  assert.equal(
    harness.order.filter((entry) => entry === `restore:${BASELINE.secretSet}`)
      .length,
    1
  )
  assert.equal(
    harness.order.filter((entry) => entry === "revoke:key-temp").length,
    1
  )
  assert.equal(
    harness.order.filter((entry) => entry === "delete:secret-set").length,
    1
  )
})

test("live runner blocks when exact-session resource usage is unavailable", async () => {
  const harness = liveHarness({ missingUsageAt: 1 })
  await assert.rejects(
    runLiveExercise({
      environment: liveEnvironment(),
      controlPlane: harness.controlPlane,
      providerFactory: () => harness.provider,
      deployCommands: { async deployProbe() {} },
      collectorFactory: () => harness.collector,
      tunnel: harness.tunnel,
      witness: harness.witness,
      sleep: async () => {},
      now: () => Date.parse("2027-01-15T08:00:00.000Z"),
    }),
    /cleanup verified/u
  )
  assert.ok(harness.order.includes(`restore:${BASELINE.secretSet}`))
})

test("failed live cleanup preserves a redacted containment record and temporary secret set", async () => {
  const harness = liveHarness({ failRestore: true, failStartAt: 1 })
  await assert.rejects(
    runLiveExercise({
      environment: liveEnvironment(),
      controlPlane: harness.controlPlane,
      providerFactory: () => harness.provider,
      deployCommands: { async deployProbe() {} },
      collectorFactory: () => harness.collector,
      tunnel: harness.tunnel,
      witness: harness.witness,
      sleep: async () => {},
    }),
    /cleanup blocked/u
  )
  assert.equal(harness.order.includes("delete:secret-set"), false)
  assert.equal(harness.containment.length, 1)
  assert.equal(
    JSON.stringify(harness.containment).includes("private-canary"),
    false
  )
})

test("secret-free evidence rejects forbidden fields, unsafe refs and raw canaries", async (t) => {
  const safe = {
    sessionRef: `sha256:${"a".repeat(64)}`,
    nested: [{ callRef: `sha256:${"b".repeat(64)}` }],
  }
  assert.equal(assertSecretFreeEvidence(safe), safe)
  for (const value of [
    { sessionId: "raw-session" },
    { nested: { privateKey: "raw-key" } },
    { sessionRef: "raw-session" },
  ]) {
    assert.throws(
      () => assertSecretFreeEvidence(value),
      /forbidden|safe reference/u
    )
  }
  assert.throws(
    () =>
      assertSecretFreeEvidence(
        { note: "contains volatile-canary here" },
        { rawValues: ["volatile-canary"] }
      ),
    /volatile raw value/u
  )

  const directory = await mkdtemp(join(tmpdir(), "duplexd-evidence-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, "evidence.json")
  await writeSecretFreeEvidence(path, safe)
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), safe)
  assert.equal((await stat(path)).mode & 0o777, 0o600)
  const replacement = { ...safe, verdict: "blocked_live_gate" }
  await writeSecretFreeEvidence(path, replacement)
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), replacement)
})

test("preflight plan is offline and rollback command uses meaningful exits", async (t) => {
  const preflight = resolve("scripts/provider-contract/live/preflight.mjs")
  const plan = spawnSync(process.execPath, [preflight, "plan"], {
    encoding: "utf8",
  })
  assert.equal(plan.status, 0, plan.stderr)
  const parsed = JSON.parse(plan.stdout)
  assert.deepEqual(parsed.baseline, BASELINE)
  assert.deepEqual(parsed.limits, LIMITS)
  assert.equal(parsed.cases.length, LIMITS.maxStarts)

  const directory = await mkdtemp(join(tmpdir(), "duplexd-preflight-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const manifest = join(directory, "manifest.json")
  const sessions = join(directory, "sessions.json")
  const keys = join(directory, "keys.json")
  const secretSets = join(directory, "secret-sets.json")
  await Promise.all([
    writeFile(manifest, JSON.stringify(BASELINE)),
    writeFile(sessions, "[]"),
    writeFile(keys, "[]"),
    writeFile(secretSets, "[]"),
  ])
  const success = spawnSync(
    process.execPath,
    [preflight, "verify-rollback", manifest, sessions, keys, secretSets],
    { encoding: "utf8" }
  )
  assert.equal(success.status, 0, success.stderr)
  assert.equal(JSON.parse(success.stdout).ok, true)

  await writeFile(sessions, "[{}]")
  const failure = spawnSync(
    process.execPath,
    [preflight, "verify-rollback", manifest, sessions, keys, secretSets],
    { encoding: "utf8" }
  )
  assert.equal(failure.status, 1)
  assert.equal(JSON.parse(failure.stdout).ok, false)

  await writeFile(sessions, "[]")
  await writeFile(
    secretSets,
    JSON.stringify([{ name: "duplexd-provider-proof" }])
  )
  const secretSetFailure = spawnSync(
    process.execPath,
    [preflight, "verify-rollback", manifest, sessions, keys, secretSets],
    { encoding: "utf8" }
  )
  assert.equal(secretSetFailure.status, 1)
  assert.match(
    JSON.parse(secretSetFailure.stdout).errors.join("\n"),
    /secret set/u
  )

  const usage = spawnSync(process.execPath, [preflight, "unknown"], {
    encoding: "utf8",
  })
  assert.equal(usage.status, 1)
  assert.match(usage.stderr, /Usage:/u)
})
