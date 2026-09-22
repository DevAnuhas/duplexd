// Run the real CLI with synthetic provider responses and process boundaries.
// The only sockets are the runner's loopback collector. Long CLI operations are
// disposable Node children so interruption exercises the real process-group kill.
import childProcess from "node:child_process"
import fs from "node:fs/promises"
import { createHmac, randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"
import { syncBuiltinESMExports } from "node:module"
import { PassThrough } from "node:stream"
import { fileURLToPath } from "node:url"

const [runDir, mode = "pending"] = process.argv.slice(2)
const realSpawn = childProcess.spawn
const localFetch = globalThis.fetch
const realNow = Date.now
let timeOffset = 0
Date.now = () => realNow() + timeOffset
const buildId = "11111111-2222-4333-8444-555555555555"
const deploymentId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
const baselineBuildId = "3010f496-fd84-4f39-a75c-c4a58a1bd922"
const baselineDigest =
  "sha256:032aa1f121bc91a22748c725966bfd21e6659daaf8b159d367fd6e0f7a745242"
let sessionId = "response-session-canary"
const serviceId = "33333333-3333-4333-8333-333333333333"
const retainedSessions = new Map()
const terminal = {
  status: "ended",
  startedAt: new Date(Date.now() - 60_000).toISOString(),
  endedAt: new Date(Date.now()).toISOString(),
  resourceMetrics: {
    sampleCount: 2,
    timeseries: [
      { t: 1, c: 10, m: 2048 },
      { t: 2, c: 10, m: 2048 },
    ],
  },
}
let collectorPort
let probePresent = false
let starts = 0
let currentProof = null
const calls = []
if (mode === "missing-private-key-recover") {
  const open = fs.open
  fs.open = async (...args) => {
    calls.push(["file-open", String(args[0])])
    return open(...args)
  }
}
const report = () => process.send({ type: "boundaries", calls, starts })
function pendingFetch(signal, phase) {
  process.send({ type: "cleanup-pending", phase })
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    signal?.addEventListener(
      "abort",
      () => {
        calls.push(["aborted", phase])
        reject(signal.reason)
      },
      { once: true }
    )
  })
}
async function probeCallback(event) {
  const { proof, expiresAt } = currentProof
  const raw = JSON.stringify({
    runId: proof.runId,
    case: proof.case,
    bootId: proof.bootId,
    sessionId,
    event,
    observedAt: new Date().toISOString(),
    dailyClaims: {
      expiresAtEpochSeconds: expiresAt,
      ejectAtTokenExpiry: true,
      isOwner: false,
      roomScoped: true,
    },
  })
  const timestamp = String(Math.floor(Date.now() / 1000))
  const nonce = randomBytes(16).toString("hex")
  const signature = createHmac(
    "sha256",
    Buffer.from(proof.callbackSecret, "base64url")
  )
    .update(`${timestamp}.${nonce}.`)
    .update(raw)
    .digest("hex")
  const response = await localFetch(
    `http://127.0.0.1:${collectorPort}${new URL(proof.callbackUrl).pathname}`,
    {
      method: "POST",
      body: raw,
      headers: {
        "x-provider-proof-timestamp": timestamp,
        "x-provider-proof-nonce": nonce,
        "x-provider-proof-signature": signature,
      },
    }
  )
  if (response.status !== 204) throw new Error("fixture callback rejected")
}
childProcess.spawn = (command, args) => {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  // Fake processes have no pid and can never target a real process group.
  if (command === "ngrok") {
    collectorPort = Number(args[1])
    return child
  }
  if (command === "open") {
    setImmediate(async () => {
      try {
        const html = await (await localFetch(args[0])).text()
        const path = JSON.parse(html.match(/fetch\(("[^"]+")/u)[1])
        const authorization = JSON.parse(
          html.match(/"authorization":("[^"]+")/u)[1]
        )
        for (const event of ["browser_joined", "browser_ejected"]) {
          const response = await localFetch(
            `http://127.0.0.1:${collectorPort}${path}`,
            {
              method: "POST",
              headers: { authorization },
              body: JSON.stringify({ case: currentProof.proof.case, event }),
            }
          )
          if (response.status !== 204)
            throw new Error("fixture witness rejected")
        }
        child.emit("exit", 0)
      } catch {
        process.send({ type: "fixture-error", phase: "witness" })
        child.emit("exit", 1)
      }
    })
    return child
  }
  if (command !== "uv") throw new Error("unexpected fixture process")
  calls.push(["command", ...args])
  const operation = args.includes("stop")
    ? "stop"
    : args.includes("delete")
      ? "delete"
      : "deploy"
  if (mode === `cleanup-${operation}`) {
    const actual = realSpawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      }
    )
    actual.on("exit", (code, signal) =>
      calls.push(["command-exit", operation, code, signal])
    )
    process.send({
      type: "cleanup-pending",
      phase: operation,
      childPid: actual.pid,
    })
    return actual
  }
  if (operation === "deploy") {
    probePresent = true
    setImmediate(() => {
      child.stdout.end(`Build ID: ${buildId}\n`)
      child.emit("exit", 0)
    })
  } else if (operation === "delete") {
    probePresent = false
    setImmediate(() => child.emit("exit", 0))
  } else if (operation === "stop") setImmediate(() => child.emit("exit", 0))
  else throw new Error("unexpected fixture command")
  return child
}
syncBuiltinESMExports()
globalThis.fetch = async (url, options = {}) => {
  const parsed = new URL(url)
  calls.push(["http", options.method ?? "GET", parsed.pathname])
  if (parsed.origin === "http://127.0.0.1:4040")
    return Response.json({
      tunnels: [
        {
          proto: "https",
          public_url: "https://local-fixture.invalid",
          config: { addr: `http://localhost:${collectorPort}` },
        },
      ],
    })
  if (parsed.origin !== "https://api.pipecat.daily.co")
    throw new Error("unexpected fixture origin")
  if (parsed.pathname.endsWith("/start")) {
    starts++
    if (mode === "pending") {
      process.send({ type: "dispatch-pending" })
      return new Promise((resolve, reject) =>
        options.signal.addEventListener(
          "abort",
          () => reject(options.signal.reason),
          { once: true }
        )
      )
    }
    if (starts > 6) throw new Error("fixture_forbids_seventh_start")
    sessionId =
      starts === 1
        ? "response-session-canary"
        : `response-session-canary-${starts}`
    const body = JSON.parse(options.body)
    const proof = body.body.providerProof
    const expiresAt = body.dailyMeetingTokenProperties.exp
    currentProof = { proof, expiresAt }
    retainedSessions.set(sessionId, { proof, stopped: false, reads: 0 })
    const claims = {
      exp: expiresAt,
      eject_at_token_exp: true,
      is_owner: mode === "unbounded-token",
      room_name: "synthetic-room",
    }
    const payload =
      mode === "malformed-token" ? "credential-canary" : JSON.stringify(claims)
    const response = {
      sessionId,
      dailyRoom: "https://synthetic.invalid/room",
      dailyToken: `x.${Buffer.from(payload).toString("base64url")}.x`,
    }
    if (mode === "missing-token") delete response.dailyToken
    if (["missing-token", "malformed-token", "unbounded-token"].includes(mode))
      timeOffset = 721_000
    if (mode === "complete-case")
      setImmediate(async () => {
        try {
          if (proof.case !== "no_registration_startup")
            await probeCallback("registered")
          await probeCallback("agent_joined")
          await probeCallback("agent_ejected")
        } catch {
          process.send({ type: "fixture-error", phase: "callback" })
        }
      })
    process.send({ type: "response-returned" })
    return Response.json(response)
  }
  if (parsed.pathname.startsWith("/v1/agents/")) {
    if (options.headers.authorization !== "Bearer private-key-canary")
      throw new Error("wrong_fixture_private_credential")
    const id = decodeURIComponent(parsed.pathname.split("/").at(-1))
    if (id === "sessions")
      return Response.json({ total_count: 0, sessions: [] })
    const retained = retainedSessions.get(id)
    if (!retained) return Response.json({}, { status: 404 })
    if (options.method === "DELETE") {
      if (mode === "cleanup-stop") return pendingFetch(options.signal, "stop")
      if (retained.stopped) {
        timeOffset += 15_000
        return Response.json({}, { status: 404 })
      }
      retained.stopped = true
      // Advance only the synthetic provider exercise clock past retry spacing.
      timeOffset += 5_000
      return Response.json({ status: "terminated", session_id: id })
    }
    if (mode === "cleanup-read") return pendingFetch(options.signal, "read")
    retained.reads++
    const ceiling = ["no_registration_startup", "hung_runtime"].includes(
      retained.proof.case
    )
    const ended =
      (mode !== "complete-case" && mode !== "cleanup-stop") ||
      retained.stopped ||
      ceiling
    return Response.json({
      ...terminal,
      sessionId: id,
      serviceId,
      organizationId: "22222222-2222-4222-8222-222222222222",
      deploymentId,
      status: ended ? "ended" : "active",
      endedAt: ended ? terminal.endedAt : null,
      resourceMetrics: { ...terminal.resourceMetrics, sessionId: id },
    })
  }
  if (parsed.pathname.endsWith("/apiKeys"))
    return Response.json({ body: { private: [], public: [] } })
  if (parsed.pathname.endsWith("/secrets"))
    return Response.json({ body: { sets: [] } })
  if (parsed.pathname.endsWith("/sessions"))
    return Response.json({ sessions: [] })
  if (parsed.pathname.includes("/builds/"))
    return Response.json({
      body: {
        build: {
          imageDigest: parsed.pathname.endsWith(baselineBuildId)
            ? baselineDigest
            : `sha256:${"1".repeat(64)}`,
        },
      },
    })
  const production = parsed.pathname.endsWith("/services/duplexd-agent")
  const probe = parsed.pathname.endsWith("/services/duplexd-provider-proof")
  if (!production && !probe) throw new Error("unexpected fixture endpoint")
  if (probe && !probePresent) return Response.json({}, { status: 404 })
  return Response.json({
    body: {
      name: production ? "duplexd-agent" : "duplexd-provider-proof",
      autoScaling: { minReplicas: 0, maxReplicas: production ? 3 : 1 },
      deployment: {
        serviceId,
        buildId: production ? baselineBuildId : buildId,
        id: production ? "production-deployment" : deploymentId,
        manifest: {
          spec: {
            envFromSecretNames: production ? ["duplexd-agent-secrets"] : [],
            ...(production ? {} : { maxSessionDurationSeconds: 600 }),
          },
        },
      },
    },
  })
}
process.env.PROVIDER_PROOF_LIVE_RELEASE = "stage-a-disposable-probe-release"
process.env.PROVIDER_PROOF_RUN_ID = "signal-run-canary"
process.env.PIPECAT_API_KEY = "credential-canary"
process.env.PIPECAT_OPERATOR_TOKEN = "operator-key-canary"
if (mode.startsWith("missing-private-key"))
  delete process.env.PIPECAT_PRIVATE_API_KEY
else process.env.PIPECAT_PRIVATE_API_KEY = "private-key-canary"
process.env.PIPECAT_ORGANIZATION = "22222222-2222-4222-8222-222222222222"
const runner = fileURLToPath(new URL("../../run.mjs", import.meta.url))
process.argv = [
  process.execPath,
  runner,
  mode === "missing-private-key-recover" ? "recover" : "live",
  "--run-dir",
  runDir,
]
process.on("beforeExit", report)
await import(runner)
