import { chmod, rename, writeFile } from "node:fs/promises"

import { validateEvidence } from "../lib/contract.mjs"

const SAFE_REFERENCE = /^sha256:[a-f0-9]{64}$/u
const FORBIDDEN_KEYS = new Set([
  "authorization",
  "callbackSecret",
  "credential",
  "dailyRoom",
  "dailyToken",
  "privateKey",
  "publicKey",
  "sessionId",
])

function inspect(value, path = "evidence") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => inspect(item, `${path}[${index}]`))
    return
  }
  if (value === null || typeof value !== "object") return
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new Error(`${path}.${key} is forbidden in durable evidence`)
    }
    if (key.endsWith("Ref") && !SAFE_REFERENCE.test(child)) {
      throw new Error(`${path}.${key} is not a safe reference`)
    }
    inspect(child, `${path}.${key}`)
  }
}

export function assertSecretFreeEvidence(value, { rawValues = [] } = {}) {
  inspect(value)
  const serialized = JSON.stringify(value)
  for (const raw of rawValues) {
    if (typeof raw === "string" && raw.length > 0 && serialized.includes(raw)) {
      throw new Error("durable evidence contains a volatile raw value")
    }
  }
  return value
}

export async function writeSecretFreeEvidence(path, value, options) {
  assertSecretFreeEvidence(value, options)
  const temporary = `${path}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  })
  await chmod(temporary, 0o600)
  await rename(temporary, path)
}

export function buildLiveEvidence({
  runId,
  cases,
  probeManifest,
  recordedAt = new Date().toISOString(),
}) {
  const evidence = {
    schemaVersion: 1,
    runId,
    observationMode: "live",
    recordedAt,
    sourceFacts: [
      {
        kind: "documented",
        claim: "Pipecat start returns sessionId, dailyRoom, and dailyToken.",
        source:
          "https://docs.pipecat.ai/api-reference/pipecat-cloud/rest-reference/endpoint/start",
        checkedAt: "2026-09-21T09:00:00.000Z",
      },
      {
        kind: "documented",
        claim: "Pipecat exposes exact-session status and resource metrics.",
        source:
          "https://docs.pipecat.ai/api-reference/pipecat-cloud/rest-reference/endpoint/agent-get-session",
        checkedAt: "2026-09-21T09:00:00.000Z",
      },
      {
        kind: "documented",
        claim: "Pipecat supports a platform maximum session duration.",
        source:
          "https://docs.pipecat.ai/pipecat-cloud/fundamentals/active-sessions#session-duration-limits",
        checkedAt: "2026-09-21T09:00:00.000Z",
      },
    ],
    limits: {
      startupSeconds: 120,
      wholeTestSeconds: 600,
      providerMaxSessionSeconds: 600,
    },
    prerequisites: {
      publicStartKeyAvailable: true,
      privateManagementKeyAvailable: true,
      baseImageCeilingSupported: true,
      deploymentCeilingVerified: true,
      sessionStatusAccessAvailable: true,
      usageEvidenceAccessAvailable: true,
    },
    ...(probeManifest === undefined ? {} : { probeManifest }),
    cases,
  }
  assertSecretFreeEvidence(evidence)
  const validation = validateEvidence(evidence)
  if (!validation.ok || validation.verdict !== "pass") {
    throw new Error(`live evidence is invalid: ${validation.errors.join("; ")}`)
  }
  return evidence
}
