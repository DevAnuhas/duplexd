import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { execFileSync, spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import {
  CASES,
  acceptProbeCallback,
  assertBoundedClaims,
  decodeClaims,
  deployFailureDiagnostic,
  isNotFoundStop,
  manifestFacts,
  reconcileProbeDeployment,
  safeRef,
  stableUsageMarker,
  verifyBaseline,
} from "../run.mjs"

const baselineManifest = {
  agentName: "duplexd-agent",
  buildId: "3010f496-fd84-4f39-a75c-c4a58a1bd922",
  imageDigest:
    "sha256:032aa1f121bc91a22748c725966bfd21e6659daaf8b159d367fd6e0f7a745242",
  minAgents: 0,
  maxAgents: 3,
  secretSets: ["duplexd-agent-secrets"],
}

test("plan fixes the six cases in serial acceptance order", () => {
  assert.deepEqual(
    CASES.map(({ id }) => id),
    [
      "cold_start",
      "cancel_before_join",
      "lost_start_response_registered",
      "no_registration_startup",
      "hung_runtime",
      "known_session_stop_retry",
    ]
  )
  const value = JSON.parse(
    execFileSync(process.execPath, [
      "scripts/provider-contract/run.mjs",
      "plan",
    ])
  )
  assert.deepEqual(value.limits, {
    starts: 6,
    providerSeconds: 600,
    caseSeconds: 720,
    billedMinutes: 72,
  })
})

test("live mode fails closed before network without an exact release", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/provider-contract/run.mjs", "live"],
    {
      env: {},
      encoding: "utf8",
    }
  )
  assert.equal(result.status, 1)
  assert.equal(result.stderr, "provider proof failed before evidence write\n")
})

test("session references are deterministic, salted, and non-reversible", () => {
  assert.equal(
    safeRef("salt-a", "raw-session"),
    safeRef("salt-a", "raw-session")
  )
  assert.notEqual(
    safeRef("salt-a", "raw-session"),
    safeRef("salt-b", "raw-session")
  )
  assert.doesNotMatch(safeRef("salt-a", "raw-session"), /raw-session/u)
})

test("deploy failures retain only an allowlisted category, exit code, and safe build reference", () => {
  const rawBuildId = "11111111-2222-4333-8444-555555555555"
  const credentialCanary = "private-credential-canary"
  const diagnostic = deployFailureDiagnostic(
    `\u001b[36mBuild started: ${rawBuildId}\u001b[0m\nDeployment is degraded: ${credentialCanary}`,
    { code: 1, salt: "test-salt" }
  )
  assert.deepEqual(diagnostic, {
    category: "deployment_degraded",
    exitCode: 1,
    buildRef: safeRef("test-salt", rawBuildId),
  })
  const serialized = JSON.stringify(diagnostic)
  assert.doesNotMatch(serialized, new RegExp(rawBuildId, "u"))
  assert.doesNotMatch(serialized, new RegExp(credentialCanary, "u"))
  assert.deepEqual(
    deployFailureDiagnostic("unrecognized provider output secret-canary", {
      code: null,
      timedOut: true,
      salt: "test-salt",
    }),
    { category: "deploy_cli_timeout", exitCode: null }
  )
})

test("a nonzero deploy exit reconciles once against the authoritative manifest", async () => {
  let deploys = 0
  let reads = 0
  const diagnostic = { category: "deployment_degraded", exitCode: 1 }
  const buildId = "11111111-2222-4333-8444-555555555555"
  const state = { manifest: { buildId: "matched-probe-build" } }
  const result = await reconcileProbeDeployment({
    deploy: async () => {
      deploys += 1
      return { buildId, diagnostic }
    },
    readManifest: async (expectedBuildId) => {
      reads += 1
      assert.equal(expectedBuildId, buildId)
      return state
    },
  })
  assert.equal(deploys, 1)
  assert.equal(reads, 1)
  assert.equal(result.state, state)
  assert.deepEqual(result.diagnostic, { ...diagnostic, reconciled: true })
})

test("a nonzero deploy exit blocks after one deploy when no matching manifest appears", async () => {
  let deploys = 0
  const diagnostic = { category: "deployment_unavailable", exitCode: 1 }
  await assert.rejects(
    reconcileProbeDeployment({
      deploy: async () => {
        deploys += 1
        return {
          buildId: "11111111-2222-4333-8444-555555555555",
          diagnostic,
        }
      },
      readManifest: async () => {
        throw new Error("provider-values-must-not-survive")
      },
    }),
    (error) => {
      assert.equal(error.message, "probe_manifest_readback_failed")
      assert.deepEqual(error.deployDiagnostic, {
        ...diagnostic,
        reconciled: false,
      })
      assert.doesNotMatch(JSON.stringify(error), /provider-values/u)
      return true
    }
  )
  assert.equal(deploys, 1)
})

test("callback authentication binds run, case, boot, and exact session", () => {
  const secret = Buffer.alloc(32, 7)
  const body = {
    runId: "stage-a-proof-r5",
    case: "cold_start",
    bootId: "boot-0001",
    sessionId: "session-exact",
    event: "registered",
    observedAt: 1,
    dailyClaims: {},
  }
  const raw = Buffer.from(JSON.stringify(body))
  const timestamp = "1789999999"
  const nonce = "a".repeat(32)
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${nonce}.`)
    .update(raw)
    .digest("hex")
  const expected = {
    secret,
    runId: body.runId,
    caseId: body.case,
    bootId: body.bootId,
    sessionId: body.sessionId,
  }
  const event = acceptProbeCallback({
    raw,
    headers: {
      "x-provider-proof-timestamp": timestamp,
      "x-provider-proof-nonce": nonce,
      "x-provider-proof-signature": signature,
    },
    expected,
    now: Number(timestamp) * 1_000,
  })
  assert.equal(event.sessionId, "session-exact")
  assert.throws(
    () =>
      acceptProbeCallback({
        raw,
        headers: {},
        expected,
        now: Number(timestamp) * 1_000,
      }),
    /callback_auth_invalid/u
  )
  assert.throws(
    () =>
      acceptProbeCallback({
        raw,
        headers: {
          "x-provider-proof-timestamp": timestamp,
          "x-provider-proof-nonce": nonce,
          "x-provider-proof-signature": signature,
        },
        expected: { ...expected, sessionId: "other" },
        now: Number(timestamp) * 1_000,
      }),
    /callback_session_mismatch/u
  )
})

test("both participant tokens must carry the exact ejection bound", () => {
  const payload = Buffer.from(
    JSON.stringify({
      properties: {
        exp: 300,
        eject_at_token_exp: true,
        is_owner: false,
        room_name: "bounded-room",
      },
    })
  ).toString("base64url")
  const claims = decodeClaims(`x.${payload}.x`)
  assert.doesNotThrow(() => assertBoundedClaims(claims, 300))
  assert.throws(
    () => assertBoundedClaims({ ...claims, isOwner: true }, 300),
    /unbounded/u
  )
})

test("real manifest nesting maps only the baseline proof fields", () => {
  const value = {
    body: {
      name: "duplexd-agent",
      autoScaling: { minReplicas: 0, maxReplicas: 3 },
      deployment: {
        id: "deployment",
        buildId: baselineManifest.buildId,
        manifest: { spec: { envFromSecretNames: ["duplexd-agent-secrets"] } },
      },
    },
  }
  assert.deepEqual(manifestFacts(value, baselineManifest.imageDigest), {
    ...baselineManifest,
    deploymentId: "deployment",
  })
})

test("rollback requires the exact baseline and clean provider state", () => {
  const keys = { body: { public: [{}], private: [] } }
  const secrets = { body: { sets: [{ name: "duplexd-agent-secrets" }] } }
  assert.equal(verifyBaseline(baselineManifest, [], keys, secrets), true)
  assert.equal(
    verifyBaseline(baselineManifest, [{ endedAt: null }], keys, secrets),
    false
  )
  assert.equal(
    verifyBaseline(
      { ...baselineManifest, maxSessionDurationSeconds: 600 },
      [],
      keys,
      secrets
    ),
    false
  )
})

test("usage cessation requires ended status and real stable-resource samples", () => {
  const ended = {
    endedAt: "2026-09-21T00:01:00.000Z",
    updatedAt: "2026-09-21T00:01:05.000Z",
    resourceMetrics: { sampleCount: 2, timeseries: [{ t: 1 }, { t: 2 }] },
  }
  assert.equal(stableUsageMarker({ ...ended, endedAt: null }), null)
  assert.equal(stableUsageMarker({ ...ended, resourceMetrics: null }), null)
  assert.equal(
    stableUsageMarker(ended),
    stableUsageMarker(structuredClone(ended))
  )
})

test("repeat stop accepts only an explicit not-found response", () => {
  assert.equal(isNotFoundStop("request failed: 404"), true)
  assert.equal(isNotFoundStop("session not found"), true)
  assert.equal(isNotFoundStop("request failed: 500"), false)
})

test("runner contains no private-key or temporary-secret mutation", () => {
  const source = readFileSync("scripts/provider-contract/run.mjs", "utf8")
  assert.doesNotMatch(
    source,
    /createPrivateKey|revokeKey|probe_secret_set_create/u
  )
  assert.doesNotMatch(source, /\/secrets\/duplexd-provider-proof/u)
  assert.equal(source.match(/\/v1\/public\/\$\{AGENT\}\/start/gu)?.length, 1)
  assert.match(source, /writeFile\(file, html, \{ mode: 0o600 \}\)/u)
  assert.ok(
    source.indexOf('stage = "cleanup_ambiguous_start_containment"') <
      source.indexOf('stage = "cleanup_restore_baseline"')
  )
})
