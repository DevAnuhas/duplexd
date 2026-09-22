import { fork } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

export async function runDirectory(t) {
  const parent = await mkdtemp(join(homedir(), ".duplexd-regression-test-"))
  t.after(() => rm(parent, { recursive: true, force: true }))
  return join(parent, "run")
}
export function fixtureChild(t, fixture, args) {
  const child = fork(fileURLToPath(new URL(fixture, import.meta.url)), args, {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  })
  const messages = []
  const waiters = []
  const nestedPids = []
  let output = ""
  child.stdout.on("data", (chunk) => {
    output += chunk
  })
  child.stderr.on("data", (chunk) => {
    output += chunk
  })
  child.on("message", (value) => {
    if (value.childPid) nestedPids.push(value.childPid)
    const index = waiters.findIndex(({ type }) => type === value.type)
    if (index < 0) messages.push(value)
    else waiters.splice(index, 1)[0].resolve(value)
  })
  const exited = once(child, "exit")
  t.after(async () => {
    for (const pid of nestedPids) {
      try {
        process.kill(-pid, "SIGKILL")
      } catch {}
    }
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL")
    await exited
  })
  return {
    child,
    exited,
    output: () => output,
    message(type, timeout = 4000) {
      const index = messages.findIndex((message) => message.type === type)
      if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0])
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`fixture ${type} timeout: ${output}`)),
          timeout
        )
        waiters.push({
          type,
          resolve(value) {
            clearTimeout(timer)
            resolve(value)
          },
        })
      })
    },
  }
}
