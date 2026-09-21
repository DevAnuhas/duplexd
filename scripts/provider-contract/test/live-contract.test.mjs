import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { request } from "node:http"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"

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
  verifyCallback,
} from "../live/protocol.mjs"
import { ProviderClient } from "../live/provider.mjs"
import {
  BASELINE,
  LIMITS,
  LiveRunState,
  abortAndRestore,
  createOperatorGuard,
  verifyRollback,
} from "../live/run-state.mjs"

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
    [LIMITS.startupSeconds * 1_000, LIMITS.wholeSessionSeconds * 1_000]
  )
  assert.ok(clock.scheduled.every((timer) => timer.unrefCalled))
  assert.throws(() => state.beginCase("case-concurrent"), /concurrency/u)

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
      throw new Error("stop-canary")
    },
    restoreBaseline: async () => {
      order.push("restore")
    },
    revokePrivateKey: async () => {
      order.push("revoke")
      throw new Error("revoke-canary")
    },
    readback: async () => {
      order.push("readback")
      return { manifest: BASELINE, sessions: [], keys: [] }
    },
  })

  assert.deepEqual(order, [
    "stop:same-session",
    "restore",
    "revoke",
    "readback",
  ])
  assert.equal(result.ok, false)
  assert.equal(result.verification.ok, true)
  assert.match(result.cleanupErrors.join("\n"), /stop-canary/u)
  assert.match(result.cleanupErrors.join("\n"), /revoke-canary/u)
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
  assert.deepEqual(
    verifyRollback({ manifest: { ...BASELINE }, sessions: [], keys: [] }),
    { ok: true, errors: [] }
  )
  assert.equal(
    verifyRollback({
      manifest: { ...BASELINE, deploymentId: "new-redeploy-id" },
      sessions: [],
      keys: [],
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
    verifyRollback({ manifest: BASELINE, sessions: [{}], keys: [] }).ok,
    false
  )
  assert.equal(
    verifyRollback({
      manifest: BASELINE,
      sessions: [],
      keys: [{ name: "Stage A provider proof", type: "public" }],
    }).ok,
    false
  )
  assert.equal(
    verifyRollback({
      manifest: BASELINE,
      sessions: [],
      keys: [{ name: "unrelated", type: "private" }],
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
  const responses = [
    jsonResponse(200, {
      sessionId: "session-123",
      dailyRoom: "https://daily.example/room",
      dailyToken: "daily-token",
    }),
    jsonResponse(200, { stopped: true }),
    jsonResponse(404, { detail: "not found" }),
    jsonResponse(200, { sessions: [{ id: "session-123" }] }),
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
  assert.deepEqual(await client.sessions("running"), [{ id: "session-123" }])
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
  assert.equal(calls[4].options.method, "POST")
  assert.deepEqual(JSON.parse(calls[4].options.body), {
    maxSessionDuration: 600,
  })
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
  await Promise.all([
    writeFile(manifest, JSON.stringify(BASELINE)),
    writeFile(sessions, "[]"),
    writeFile(keys, "[]"),
  ])
  const success = spawnSync(
    process.execPath,
    [preflight, "verify-rollback", manifest, sessions, keys],
    { encoding: "utf8" }
  )
  assert.equal(success.status, 0, success.stderr)
  assert.equal(JSON.parse(success.stdout).ok, true)

  await writeFile(sessions, "[{}]")
  const failure = spawnSync(
    process.execPath,
    [preflight, "verify-rollback", manifest, sessions, keys],
    { encoding: "utf8" }
  )
  assert.equal(failure.status, 1)
  assert.equal(JSON.parse(failure.stdout).ok, false)

  const usage = spawnSync(process.execPath, [preflight, "unknown"], {
    encoding: "utf8",
  })
  assert.equal(usage.status, 1)
  assert.match(usage.stderr, /Usage:/u)
})
