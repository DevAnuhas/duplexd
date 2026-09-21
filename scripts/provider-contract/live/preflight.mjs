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
      "node scripts/provider-contract/live/collector.mjs # with secret/run/cases in environment",
    tunnel: "ngrok http http://127.0.0.1:<collector-port>",
    probeDeploy:
      "cd agent && uv run pipecat cloud deploy duplexd-agent --build-dir . --dockerfile Dockerfile --min-agents 0 --max-agents 1 --secrets duplexd-agent-secrets --profile agent-1x",
    setCeiling:
      "Dashboard/private API: set maxSessionDuration=600; then read back maxSessionDurationSeconds=600 before starts",
    rollback:
      "cd agent && uv run pipecat cloud deploy duplexd-agent --build-id 3010f496 --min-agents 0 --max-agents 3 --secrets duplexd-agent-secrets --profile agent-1x",
    rollbackGate:
      "Read back buildId/imageDigest/scaling, require maxSessionDurationSeconds absent, zero sessions, and temporary private key absent",
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
  if (command === "verify-rollback" && paths.length === 3) {
    const [manifest, sessions, keys] = await Promise.all(
      paths.map(async (path) => JSON.parse(await readFile(path, "utf8")))
    )
    const result = verifyRollback({ manifest, sessions, keys })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    process.exitCode = result.ok ? 0 : 1
    return
  }
  throw new Error(
    "Usage: preflight.mjs plan | verify-rollback <manifest.json> <sessions.json> <keys.json>"
  )
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "preflight failed"}\n`
  )
  process.exitCode = 1
})
