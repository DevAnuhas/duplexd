#!/usr/bin/env node

import { readFile } from "node:fs/promises"
import process from "node:process"

import { safeReference, validateEvidence } from "./lib/contract.mjs"

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString("utf8").trim()
}

function usage() {
  return [
    "Usage:",
    "  node scripts/provider-contract/run.mjs validate <evidence.json>",
    "  printf '%s' '<provider reference>' | node scripts/provider-contract/run.mjs safe-ref",
  ].join("\n")
}

async function main() {
  const [command, argument, ...extra] = process.argv.slice(2)
  if (extra.length > 0) {
    throw new Error(usage())
  }

  if (command === "safe-ref" && argument === undefined) {
    const raw = await readStdin()
    process.stdout.write(`${safeReference(raw)}\n`)
    return
  }

  if (command === "validate" && argument !== undefined) {
    const value = JSON.parse(await readFile(argument, "utf8"))
    const result = validateEvidence(value)
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    process.exitCode = result.ok ? 0 : 1
    return
  }

  throw new Error(usage())
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "Unknown failure."
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
})

