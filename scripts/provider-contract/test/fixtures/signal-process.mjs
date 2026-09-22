// Run the real CLI and its signal handlers with every external process and HTTP
// boundary replaced locally. Any unexpected URL/command aborts this fixture.
import childProcess from "node:child_process"
import { EventEmitter } from "node:events"
import { syncBuiltinESMExports } from "node:module"
import { PassThrough } from "node:stream"
import { fileURLToPath } from "node:url"

const runDir = process.argv[2]
const buildId = "11111111-2222-4333-8444-555555555555"
const deploymentId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
const baselineBuildId = "3010f496-fd84-4f39-a75c-c4a58a1bd922"
const baselineDigest =
  "sha256:032aa1f121bc91a22748c725966bfd21e6659daaf8b159d367fd6e0f7a745242"
let probePresent = false
let starts = 0
const calls = []
const report = () => process.send({ type: "boundaries", calls, starts })
childProcess.spawn = (command, args) => {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  // No pid: cleanup's process-group kill throws locally and cannot target a process.
  if (command === "ngrok") return child
  if (command !== "uv") throw new Error("unexpected fixture process")
  calls.push(["command", ...args])
  if (args.includes("deploy")) {
    probePresent = true
    setImmediate(() => {
      child.stdout.end(`Build ID: ${buildId}\n`)
      child.emit("exit", 0)
    })
  } else if (args.includes("delete")) {
    probePresent = false
    setImmediate(() => child.emit("exit", 0))
  } else throw new Error("unexpected fixture command")
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
          config: { addr: "http://localhost:1" },
        },
      ].map((tunnel) => ({
        ...tunnel,
        config: { addr: `http://localhost:${collectorPort}` },
      })),
    })
  if (parsed.origin !== "https://api.pipecat.daily.co")
    throw new Error("unexpected fixture origin")
  if (parsed.pathname.endsWith("/start")) {
    starts++
    process.send({ type: "dispatch-pending" })
    return new Promise((resolve, reject) => {
      options.signal.addEventListener(
        "abort",
        () => reject(options.signal.reason),
        { once: true }
      )
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
// ngrok receives the actual collector port, so capture that process argument.
let collectorPort
const spawn = childProcess.spawn
childProcess.spawn = (command, args, options) => {
  if (command === "ngrok") collectorPort = Number(args[1])
  return spawn(command, args, options)
}
syncBuiltinESMExports()
process.env.PROVIDER_PROOF_LIVE_RELEASE = "stage-a-disposable-probe-release"
process.env.PROVIDER_PROOF_RUN_ID = "signal-run-canary"
process.env.PIPECAT_API_KEY = "credential-canary"
process.env.PIPECAT_OPERATOR_TOKEN = "credential-canary"
process.env.PIPECAT_ORGANIZATION = "org-canary-private"
const runner = fileURLToPath(new URL("../../run.mjs", import.meta.url))
process.argv = [process.execPath, runner, "live", "--run-dir", runDir]
process.on("beforeExit", report)
await import(runner)
