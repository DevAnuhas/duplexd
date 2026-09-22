// Synchronization lives entirely in this test process, never the runner.
import fs from "node:fs/promises"
import childProcess from "node:child_process"
import { EventEmitter } from "node:events"
import { syncBuiltinESMExports } from "node:module"
import { join } from "node:path"
const [mode, runDir] = process.argv.slice(2)
let heldRead = false
let releaseRead
if (mode === "lock") {
  const readFile = fs.readFile
  fs.readFile = async (...args) => {
    const value = await readFile(...args)
    if (args[0] === join(runDir, "writer.lock") && !heldRead) {
      heldRead = true
      process.send({ type: "phase", phase: "stale-read" })
      await new Promise((resolve) => {
        releaseRead = resolve
      })
    }
    return value
  }
}
if (mode === "witness")
  childProcess.spawn = (command) => {
    if (command !== "open") throw new Error("unexpected_test_process")
    const child = new EventEmitter()
    setImmediate(() => child.emit("exit", 0))
    return child
  }
syncBuiltinESMExports()
const { DurableRunStore, startCollector } = await import("../../run.mjs")
if (mode === "lock") {
  let store
  process.on("message", async (message) => {
    if (message === "release-read") releaseRead?.()
    if (message === "close") {
      await store?.close()
      process.send({ type: "closed" })
      process.disconnect()
    }
  })
  try {
    store = await DurableRunStore.open(runDir)
    process.send({ type: "phase", phase: "acquired", pid: process.pid })
  } catch (error) {
    process.send({ type: "phase", phase: "denied", error: error.message })
  }
} else if (mode === "witness") {
  const store = await DurableRunStore.create(runDir, {
    runId: "witness-run",
    organization: "synthetic-org",
  })
  const collector = await startCollector({ store, scratch: runDir })
  let error = null
  try {
    for (const caseId of ["cold_start", "no_registration_startup"])
      await collector.openWitness({
        caseId,
        dailyRoom: "https://synthetic.invalid",
        dailyToken: "runtime-only-token-canary",
      })
  } catch (caught) {
    error = caught.code ?? caught.message
  }
  const files = await fs.readdir(runDir)
  const witnesses = []
  for (const file of files.filter((name) => name.endsWith(".html")))
    witnesses.push({
      file,
      mode: (await fs.stat(join(runDir, file))).mode & 0o777,
    })
  await collector.close()
  await store.close()
  process.send({ type: "witnesses", error, witnesses })
  process.disconnect()
}
