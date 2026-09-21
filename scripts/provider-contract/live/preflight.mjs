#!/usr/bin/env node

import { readFile } from "node:fs/promises"
import process from "node:process"

import { BASELINE, LIMITS, verifyRollback } from "./run-state.mjs"

const CASES = [
  "cold_start",
  "cancel_before_join",
  "lost_start_response_registered",
  "no_registration_startup",
  "hung_runtime",
  "known_session_stop_retry",
]

function commands() {
  return {
    collector:
      "owned internally by node scripts/provider-contract/live/execute.mjs execute",
    tunnel:
      "owned internally by the same executable and destroyed during cleanup",
    probeDeploy:
      "cd agent && uv run pipecat cloud deploy duplexd-agent --build-dir . --dockerfile Dockerfile --min-agents 0 --max-agents 1 --secrets duplexd-provider-proof --profile agent-1x --organization $PIPECAT_ORGANIZATION --force --yes",
    setCeiling:
      "live executable sets maxSessionDuration=600 and requires maxSessionDurationSeconds=600 readback before starts",
    rollback:
      "authenticated control-plane restore uses full build 3010f496-fd84-4f39-a75c-c4a58a1bd922, min0/max3, and duplexd-agent-secrets",
    rollbackGate:
      "Read back full buildId/imageDigest/scaling/original secret set, require duration absent, zero sessions, private key absent, and duplexd-provider-proof absent",
    execute:
      "node scripts/provider-contract/live/execute.mjs execute # only with all explicitly released environment gates",
  }
}

async function main() {
  const [command, ...paths] = process.argv.slice(2)
  if (command === "plan") {
    process.stdout.write(
      `${JSON.stringify({ baseline: BASELINE, limits: LIMITS, cases: CASES, commands: commands() }, null, 2)}\n`
    )
    return
  }
  if (command === "verify-rollback" && paths.length === 4) {
    const [manifest, sessions, keys, secretSets] = await Promise.all(
      paths.map(async (path) => JSON.parse(await readFile(path, "utf8")))
    )
    const result = verifyRollback({ manifest, sessions, keys, secretSets })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    process.exitCode = result.ok ? 0 : 1
    return
  }
  throw new Error(
    "Usage: preflight.mjs plan | verify-rollback <manifest.json> <sessions.json> <keys.json> <secret-sets.json>"
  )
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "preflight failed"}\n`
  )
  process.exitCode = 1
})
