#!/usr/bin/env node

import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto"
import { spawn } from "node:child_process"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const PROBE_ROOT = join(ROOT, "scripts/provider-contract/probe")
const PROD_AGENT = "duplexd-agent"
const PROBE_AGENT = "duplexd-provider-proof"
const ORIGIN = "https://api.pipecat.daily.co"
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

let liveSignal = null

const delay = (milliseconds) =>
  new Promise((resolvePromise, reject) => {
    const signal = liveSignal
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

export function safeRef(salt, value) {
  return createHash("sha256")
    .update(`${salt}\0${value}`)
    .digest("hex")
    .slice(0, 24)
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
  ) {
    throw new Error("daily_claims_unbounded")
  }
}

export function manifestFacts(value, imageDigest) {
  const body = value?.body
  const deployment = body?.deployment
  const spec = deployment?.manifest?.spec
  const secrets = spec?.envFromSecretNames ?? []
  if (!body || !deployment || !spec || !Array.isArray(secrets))
    throw new Error("manifest_shape_invalid")
  const duration =
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
    !sets.some((set) => set.name === "duplexd-provider-proof")
  )
}

export function verifyProbeManifest(manifest, buildId) {
  return (
    manifest.agentName === PROBE_AGENT &&
    manifest.buildId === buildId &&
    /^sha256:[a-f0-9]{64}$/u.test(manifest.imageDigest) &&
    manifest.imageDigest !== BASELINE.imageDigest &&
    manifest.minAgents === 0 &&
    manifest.maxAgents === 1 &&
    manifest.secretSets.length === 0
  )
}

export function stableUsageMarker(session) {
  const metrics = session.resourceMetrics
  const lastSample = Array.isArray(metrics?.timeseries)
    ? metrics.timeseries.at(-1)
    : null
  if (
    session.endedAt == null ||
    !Number.isSafeInteger(metrics?.sampleCount) ||
    metrics.sampleCount < 1 ||
    !Number.isFinite(lastSample?.t)
  ) {
    return null
  }
  return JSON.stringify({
    endedAt: session.endedAt,
    updatedAt: session.updatedAt,
    sampleCount: metrics.sampleCount,
    lastSampleAt: lastSample.t,
  })
}

export function isNotFoundStop(output) {
  return /(?:404|not found)/iu.test(output)
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
  ) {
    throw new Error("callback_auth_invalid")
  }
  if (Math.abs(now - Number(timestamp) * 1_000) > 30_000)
    throw new Error("callback_expired")
  const actual = Buffer.from(signature ?? "", "hex")
  const wanted = createHmac("sha256", expected.secret)
    .update(`${timestamp}.${nonce}.`)
    .update(raw)
    .digest()
  if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) {
    throw new Error("callback_auth_invalid")
  }
  const body = JSON.parse(raw.toString("utf8"))
  if (
    body.runId !== expected.runId ||
    body.case !== expected.caseId ||
    body.bootId !== expected.bootId ||
    typeof body.sessionId !== "string" ||
    !["registered", "agent_joined", "agent_ejected"].includes(body.event)
  ) {
    throw new Error("callback_correlation_invalid")
  }
  if (expected.sessionId && body.sessionId !== expected.sessionId) {
    throw new Error("callback_session_mismatch")
  }
  return { ...body, nonce }
}

async function runCommand(
  args,
  { timeoutMs = 10 * 60_000, allowFailure = false } = {}
) {
  return new Promise((resolvePromise, reject) => {
    const signal = liveSignal
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
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (chunk) => {
        if (output.length < 32_000) output += chunk.toString("utf8")
      })
    }
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
    const abort = () => {
      try {
        process.kill(-child.pid, "SIGTERM")
      } catch {}
    }
    signal?.addEventListener("abort", abort, { once: true })
    child.once("error", () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      reject(new Error("cli_start_failed"))
    })
    child.once("exit", (code) => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      if (code === 0 || allowFailure) resolvePromise({ code, output, timedOut })
      else reject(new Error("cli_command_failed"))
    })
  })
}

async function requestJson(
  url,
  { token, method = "GET", body, timeoutMs = 30_000 }
) {
  const signals = [AbortSignal.timeout(timeoutMs)]
  if (liveSignal) signals.push(liveSignal)
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.any(signals),
  })
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
    {
      token: operatorToken,
    }
  )
  const build = buildValue?.body?.build ?? buildValue?.build ?? buildValue
  const imageDigest = build?.imageDigest ?? build?.digest
  if (typeof imageDigest !== "string")
    throw new Error("manifest_digest_missing")
  const sessionValue = await requestJson(
    `${base}/services/${agentName}/sessions`,
    {
      token: operatorToken,
    }
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

async function readSession(base, operatorToken, sessionId) {
  const value = await requestJson(`${base}/services/${PROBE_AGENT}/sessions`, {
    token: operatorToken,
  })
  const sessions = value?.sessions ?? value?.body?.sessions ?? value
  if (!Array.isArray(sessions)) throw new Error("session_list_invalid")
  const session = sessions.find(
    (item) => (item.sessionId ?? item.id) === sessionId
  )
  if (!session) throw new Error("session_detail_missing")
  return session
}

async function waitForStableEnd(base, operatorToken, sessionId, deadline) {
  let previous = null
  while (Date.now() < deadline) {
    const session = await readSession(base, operatorToken, sessionId)
    const marker = stableUsageMarker(session)
    if (marker && marker === previous) return session
    previous = marker
    await delay(5_000)
  }
  throw new Error("session_usage_not_stable")
}

async function startCollector({ scratch }) {
  const expected = new Map()
  const events = new Map()
  const usedNonces = new Set()
  let witness = null
  const server = createServer(async (request, response) => {
    try {
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
      for await (const chunk of request) chunks.push(chunk)
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
        ) {
          throw new Error("witness_event")
        }
        const key = `${body.case}:${body.event}`
        events.set(key, { ...body, observedAt: new Date().toISOString() })
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
      if (usedNonces.has(event.nonce)) throw new Error("callback_replay")
      usedNonces.add(event.nonce)
      events.set(`${event.case}:${event.event}`, event)
      response.writeHead(204).end()
    } catch {
      response.writeHead(401).end()
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
      for (const event of events.values()) {
        if (event.bootId === bootId && event.sessionId !== sessionId) {
          throw new Error("callback_session_mismatch")
        }
      }
    },
    async wait(caseId, event, deadline) {
      const key = `${caseId}:${event}`
      while (Date.now() < deadline) {
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
const call=window.DailyIframe.createCallObject();
call.on("joined-meeting",()=>report("browser_joined"));
call.on("left-meeting",()=>report("browser_ejected"));
call.join({url:${JSON.stringify(dailyRoom)},token:${JSON.stringify(dailyToken)}});
</script>`
      await writeFile(file, html, { mode: 0o600 })
      await chmod(file, 0o600)
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
      if (typeof url === "string" && url.startsWith("https://")) {
        return {
          url,
          close() {
            try {
              process.kill(-child.pid, "SIGTERM")
            } catch {}
          },
        }
      }
    } catch {}
    await delay(250)
  }
  try {
    process.kill(-child.pid, "SIGTERM")
  } catch {}
  throw new Error("tunnel_start_failed")
}

async function stopExact(organization, sessionId, retry = false) {
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
    { timeoutMs: 60_000, allowFailure: retry }
  )
  if (retry && result.code !== 0 && !isNotFoundStop(result.output)) {
    throw new Error("repeat_stop_not_404")
  }
  return retry ? 404 : 200
}

async function deployProbe(organization, salt) {
  const result = await runCommand(
    [
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
    ],
    { allowFailure: true }
  )
  if (result.code !== 0) {
    return {
      buildId: deployBuildId(result.output),
      diagnostic: deployFailureDiagnostic(result.output, {
        code: result.code,
        timedOut: result.timedOut,
        salt,
      }),
    }
  }
  return {
    buildId: deployBuildId(result.output),
    diagnostic: { category: "deploy_cli_success", exitCode: 0 },
  }
}

async function deleteProbe(organization) {
  await runCommand([
    "cloud",
    "agent",
    "delete",
    PROBE_AGENT,
    "--organization",
    organization,
    "--force",
  ])
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

async function waitForProbeAbsent(operatorToken, organization, deadline) {
  while (Date.now() < deadline) {
    if (await probeAbsent(operatorToken, organization)) return true
    await delay(5_000)
  }
  throw new Error("probe_service_delete_unverified")
}

function billedMinutes(session) {
  const start = Date.parse(session.createdAt)
  const end = Date.parse(session.endedAt)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    throw new Error("session_usage_invalid")
  }
  return (end - start) / 60_000
}

async function main() {
  if (process.argv[2] === "plan") {
    process.stdout.write(
      `${JSON.stringify({ agent: PROBE_AGENT, productionAgent: PROD_AGENT, baseline: BASELINE, limits: LIMITS, cases: CASES })}\n`
    )
    return
  }
  if (process.argv[2] !== "live") throw new Error("usage: run.mjs plan|live")
  if (
    process.env.PROVIDER_PROOF_LIVE_RELEASE !==
    "stage-a-disposable-probe-release"
  ) {
    throw new Error("live_release_missing")
  }
  const runId = process.env.PROVIDER_PROOF_RUN_ID
  const evidencePath = process.env.PROVIDER_PROOF_EVIDENCE_PATH
  const publicKey = process.env.PIPECAT_API_KEY
  const operatorToken = process.env.PIPECAT_OPERATOR_TOKEN
  const organization = process.env.PIPECAT_ORGANIZATION
  if (
    ![runId, evidencePath, publicKey, operatorToken, organization].every(
      (value) => value
    )
  ) {
    throw new Error("live_prerequisite_missing")
  }

  let stage = "baseline_preflight"
  let collector = null
  let tunnel = null
  let probeDeployed = false
  let cleanupStarted = false
  let starts = 0
  let totalBilled = 0
  let probeDeploymentId = null
  let ambiguousStart = false
  let ambiguousStartedAt = null
  const knownSessions = new Set()
  const caseEvidence = []
  const salt = randomBytes(32).toString("base64url")
  const scratch = await mkdtemp(join(tmpdir(), "duplexd-provider-proof-"))
  await chmod(scratch, 0o700)
  let finalStatus
  let finalReason
  let failureDiagnostic = null
  let finalBaseline = false
  let finalProbeAbsent = false
  const controller = new AbortController()
  liveSignal = controller.signal

  const cleanup = async () => {
    if (cleanupStarted) return
    cleanupStarted = true
    try {
      if (ambiguousStart) {
        stage = "cleanup_ambiguous_start_containment"
        await delay(
          Math.max(
            0,
            ambiguousStartedAt + LIMITS.providerSeconds * 1_000 - Date.now()
          )
        )
        let empty = 0
        const deadline = ambiguousStartedAt + LIMITS.caseSeconds * 1_000
        while (Date.now() < deadline && empty < 2) {
          const state = await readControlPlane(
            operatorToken,
            organization,
            PROBE_AGENT
          )
          const active = state.sessions.filter(
            (session) =>
              session.deploymentId === probeDeploymentId &&
              session.endedAt == null
          )
          empty = active.length === 0 ? empty + 1 : 0
          if (empty < 2) await delay(5_000)
        }
        if (empty < 2) throw new Error("ambiguous_start_uncontained")
        ambiguousStart = false
      }
      stage = "cleanup_stop_known_sessions"
      for (const sessionId of knownSessions) {
        await stopExact(organization, sessionId, true)
        const base = `${ORIGIN}/v1/organizations/${encodeURIComponent(organization)}`
        await waitForStableEnd(
          base,
          operatorToken,
          sessionId,
          Date.now() + 120_000
        )
      }
      if (probeDeployed) {
        if (!(await probeAbsent(operatorToken, organization))) {
          stage = "cleanup_delete_probe_service"
          await deleteProbe(organization)
        }
      }
      stage = "cleanup_verify_probe_absent"
      finalProbeAbsent = await waitForProbeAbsent(
        operatorToken,
        organization,
        Date.now() + 120_000
      )
      stage = "cleanup_verify_baseline"
      const state = await waitForManifest(
        operatorToken,
        organization,
        PROD_AGENT,
        (manifest) =>
          manifest.buildId === BASELINE.buildId &&
          manifest.imageDigest === BASELINE.imageDigest &&
          manifest.minAgents === 0 &&
          manifest.maxAgents === 3 &&
          JSON.stringify(manifest.secretSets) ===
            JSON.stringify([BASELINE.secretSet]) &&
          !Object.hasOwn(manifest, "maxSessionDurationSeconds"),
        Date.now() + 120_000
      )
      finalBaseline = verifyBaseline(
        state.manifest,
        state.sessions,
        state.keys,
        state.secretSets
      )
      if (!finalBaseline) throw new Error("baseline_cleanup_unverified")
      knownSessions.clear()
    } finally {
      tunnel?.close()
      await collector?.close()
    }
  }

  const onSignal = () => {
    finalReason = "operator_signal"
    controller.abort()
  }
  process.once("SIGINT", onSignal)
  process.once("SIGTERM", onSignal)

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
    ) {
      throw new Error("baseline_preflight_failed")
    }
    stage = "probe_absence_preflight"
    if (!(await probeAbsent(operatorToken, organization))) {
      throw new Error("probe_service_already_exists")
    }
    stage = "collector_start"
    collector = await startCollector({ scratch })
    stage = "tunnel_start"
    tunnel = await startTunnel(collector.port)
    stage = "probe_deploy"
    // Delete even when the CLI deploy succeeds but its response is lost.
    probeDeployed = true
    const reconciledDeploy = await reconcileProbeDeployment({
      deploy: () => deployProbe(organization, salt),
      readManifest: (probeBuildId) => {
        stage = "probe_manifest_readback"
        return waitForManifest(
          operatorToken,
          organization,
          PROBE_AGENT,
          (manifest) =>
            verifyProbeManifest(manifest, probeBuildId) &&
            manifest.maxSessionDurationSeconds === LIMITS.providerSeconds &&
            /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(
              manifest.deploymentId
            ),
          Date.now() + 120_000
        )
      },
    })
    const probeState = reconciledDeploy.state
    if (reconciledDeploy.diagnostic.exitCode !== 0) {
      failureDiagnostic = reconciledDeploy.diagnostic
    }
    probeDeploymentId = probeState.manifest.deploymentId

    for (const definition of CASES) {
      stage = `case_${definition.id}_start`
      if (starts >= LIMITS.starts) throw new Error("start_limit_exceeded")
      const dispatchedAt = Date.now()
      const deadline = dispatchedAt + LIMITS.caseSeconds * 1_000
      const expiresAt = Math.floor(dispatchedAt / 1_000) + 300
      const bootId = randomUUID()
      const callbackSecret = randomBytes(32).toString("base64url")
      const callbackPath = `/probe/${runId}/${definition.id}/${bootId}`
      collector.register({
        runId,
        caseId: definition.id,
        bootId,
        path: callbackPath,
        secret: Buffer.from(callbackSecret, "base64url"),
      })
      starts += 1
      ambiguousStart = true
      ambiguousStartedAt = dispatchedAt
      let start
      try {
        start = await requestJson(`${ORIGIN}/v1/public/${PROBE_AGENT}/start`, {
          token: publicKey,
          method: "POST",
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
          timeoutMs: 120_000,
        })
      } catch {
        stage = `case_${definition.id}_ambiguous_start`
        try {
          const registered = await collector.wait(
            definition.id,
            "registered",
            dispatchedAt + 120_000
          )
          knownSessions.add(registered.sessionId)
          await stopExact(organization, registered.sessionId)
          ambiguousStart = false
        } catch {
          await delay(
            Math.max(
              0,
              dispatchedAt + LIMITS.providerSeconds * 1_000 - Date.now()
            )
          )
          let empty = 0
          while (Date.now() < deadline && empty < 2) {
            const state = await readControlPlane(
              operatorToken,
              organization,
              PROBE_AGENT
            )
            const active = state.sessions.filter(
              (session) =>
                session.deploymentId === probeDeploymentId &&
                session.endedAt == null
            )
            empty = active.length === 0 ? empty + 1 : 0
            if (empty < 2) await delay(5_000)
          }
          if (empty < 2) throw new Error("ambiguous_start_uncontained")
          ambiguousStart = false
        }
        throw new Error("ambiguous_start_no_retry")
      }
      if (
        ![start?.sessionId, start?.dailyRoom, start?.dailyToken].every(
          (value) => typeof value === "string"
        )
      ) {
        throw new Error("start_response_invalid")
      }
      collector.bindSession(bootId, start.sessionId)
      ambiguousStart = false
      knownSessions.add(start.sessionId)
      const browserClaims = decodeClaims(start.dailyToken)
      assertBoundedClaims(browserClaims, expiresAt)
      let registered = null
      if (definition.id !== "no_registration_startup") {
        stage = `case_${definition.id}_registration`
        registered = await collector.wait(definition.id, "registered", deadline)
        if (registered.sessionId !== start.sessionId)
          throw new Error("registration_session_mismatch")
      }
      let browserEjected = null
      let agentEjected = null
      let agentJoined = null
      let browserJoined = null
      if (definition.join) {
        stage = `case_${definition.id}_participants_join`
        await collector.openWitness({
          caseId: definition.id,
          dailyRoom: start.dailyRoom,
          dailyToken: start.dailyToken,
        })
        browserJoined = await collector.wait(
          definition.id,
          "browser_joined",
          deadline
        )
        agentJoined = await collector.wait(
          definition.id,
          "agent_joined",
          deadline
        )
        if (agentJoined.sessionId !== start.sessionId) {
          throw new Error("agent_join_session_mismatch")
        }
        assertBoundedClaims(agentJoined.dailyClaims, expiresAt)
        if (!browserJoined) throw new Error("browser_join_failed")
      }
      if (
        definition.id === "no_registration_startup" &&
        collector.has(definition.id, "registered")
      ) {
        throw new Error("unexpected_registration")
      }
      const stopAttempts = []
      if (definition.stop === "ceiling") {
        stage = `case_${definition.id}_media_ejection`
        browserEjected = await collector.wait(
          definition.id,
          "browser_ejected",
          deadline
        )
        agentEjected = await collector.wait(
          definition.id,
          "agent_ejected",
          deadline
        )
        if (agentEjected.sessionId !== start.sessionId) {
          throw new Error("agent_ejection_session_mismatch")
        }
        if (
          Date.parse(browserEjected.observedAt) < expiresAt * 1_000 - 5_000 ||
          agentEjected.observedAt * 1_000 < expiresAt * 1_000 - 5_000
        ) {
          throw new Error("participant_ejected_before_expiry")
        }
      } else {
        stage = `case_${definition.id}_stop`
        const cleanupId = definition.discard
          ? registered.sessionId
          : start.sessionId
        stopAttempts.push({
          status: await stopExact(organization, cleanupId),
          observedAt: new Date().toISOString(),
        })
        if (definition.stop === "twice") {
          stage = `case_${definition.id}_stop_retry`
          stopAttempts.push({
            status: await stopExact(organization, cleanupId, true),
            observedAt: new Date().toISOString(),
          })
        }
      }
      stage = `case_${definition.id}_reconcile`
      const ended = await waitForStableEnd(
        probeState.base,
        operatorToken,
        start.sessionId,
        deadline
      )
      knownSessions.delete(start.sessionId)
      const used = billedMinutes(ended)
      totalBilled += used
      if (totalBilled > LIMITS.billedMinutes)
        throw new Error("billed_limit_exceeded")
      caseEvidence.push({
        case: definition.id,
        sessionRef: safeRef(salt, start.sessionId),
        dispatchedAt: new Date(dispatchedAt).toISOString(),
        expiresAt: new Date(expiresAt * 1_000).toISOString(),
        startFields: true,
        registrationMatched: definition.id !== "no_registration_startup",
        registeredAt: registered
          ? new Date(registered.observedAt * 1_000).toISOString()
          : null,
        applicationStartResponseDiscarded: definition.discard === true,
        stopAttempts,
        browserClaimsBounded: definition.join ? true : null,
        agentClaimsBounded: definition.join ? true : null,
        browserJoinedAt:
          definition.join && browserJoined ? browserJoined.observedAt : null,
        agentJoinedAt: agentJoined
          ? new Date(agentJoined.observedAt * 1_000).toISOString()
          : null,
        browserEjectedAt: browserEjected?.observedAt ?? null,
        agentEjectedAt: agentEjected
          ? new Date(agentEjected.observedAt * 1_000).toISOString()
          : null,
        cessationBoundary:
          definition.stop === "ceiling"
            ? "provider_execution_ceiling"
            : "exact_session_stop",
        providerEndedAt: ended.endedAt,
        usageStableAt: new Date().toISOString(),
        usageStable: true,
        billedMinutes: used,
      })
    }
    finalStatus = "pass"
    finalReason = "six_cases_observed"
  } catch (error) {
    finalStatus = "blocked"
    finalReason = stage
    if (error?.deployDiagnostic) {
      failureDiagnostic = error.deployDiagnostic
    }
  }

  liveSignal = null
  try {
    await cleanup()
  } catch {
    finalStatus = "blocked"
    finalReason = "cleanup_unverified"
  }
  const evidence = {
    status: finalStatus,
    reason: finalReason,
    runId,
    starts,
    totalBilledMinutes: totalBilled,
    limits: LIMITS,
    cases: caseEvidence,
    cleanup: {
      productionUnchanged: finalBaseline,
      probeServiceAbsent: finalProbeAbsent,
      zeroKnownSessions: knownSessions.size === 0,
    },
    ...(failureDiagnostic ? { diagnostic: failureDiagnostic } : {}),
  }
  try {
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
      mode: 0o600,
    })
    await chmod(evidencePath, 0o600)
  } finally {
    await rm(scratch, { recursive: true, force: true })
    process.removeListener("SIGINT", onSignal)
    process.removeListener("SIGTERM", onSignal)
  }
  process.stdout.write(
    `${JSON.stringify({ status: finalStatus, reason: finalReason, evidencePath })}\n`
  )
  process.exitCode = finalStatus === "pass" ? 0 : 1
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(() => {
    process.stderr.write("provider proof failed before evidence write\n")
    process.exitCode = 1
  })
}
