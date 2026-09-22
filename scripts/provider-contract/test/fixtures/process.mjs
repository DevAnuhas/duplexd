// Child-only filesystem fault injection; never loaded by the operator runner.
import fs from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import { join } from "node:path"
import { identity, seed, dependencies } from "./state.mjs"

const [mode, runDir] = process.argv.slice(2)
let releaseSync
let blockJournal = false
let failJournal = false
const originalOpen = fs.open
fs.open = async (...args) => {
  const handle = await originalOpen(...args)
  if (args[0] === join(runDir, "events.ndjson")) {
    const originalSync = handle.sync.bind(handle)
    handle.sync = async () => {
      if (failJournal)
        throw Object.assign(new Error("EIO credential-canary"), { code: "EIO" })
      if (blockJournal) {
        blockJournal = false
        process.send({ type: "sync-blocked" })
        await new Promise((resolve) => {
          releaseSync = resolve
        })
      }
      await originalSync()
    }
  }
  return handle
}
syncBuiltinESMExports()
const { DurableRunStore, startCollector, cleanupRun, safeRef } =
  await import("../../run.mjs")

if (mode === "recover") {
  const store = await DurableRunStore.open(runDir)
  const { deps, calls } = dependencies(store)
  const completed = await cleanupRun(store, deps)
  const summary = await store.writeSummary()
  process.send({
    type: "recovered",
    completed,
    calls,
    summary,
    recovery: store.recovery,
    callbacks: store.records.filter((record) => record.kind === "callback"),
  })
  await store.close()
  process.disconnect()
} else {
  const store = await DurableRunStore.create(runDir, identity)
  await seed(store, { session: false, outcome: "unknown" })
  const collector = await startCollector({ store, scratch: runDir })
  collector.register(identity)
  process.on("message", async (message) => {
    if (message === "release-sync") releaseSync?.()
    if (message === "block-sync") {
      blockJournal = true
      process.send({ type: "armed" })
    }
    if (message === "fail-sync") {
      failJournal = true
      process.send({ type: "armed" })
    }
    if (message === "contain") {
      const { deps, calls } = dependencies(store)
      let error = null
      try {
        await cleanupRun(store, deps)
      } catch {
        error = "containment_failed"
      }
      process.send({
        type: "contained",
        calls,
        error,
        summary: await store.writeSummary(),
        session:
          store.recovery.sessions[
            safeRef(store.recovery.salt, identity.sessionId)
          ],
      })
    }
    if (message === "close") {
      await collector.close()
      await store.close()
      process.disconnect()
    }
  })
  process.send({ type: "ready", port: collector.port })
}
