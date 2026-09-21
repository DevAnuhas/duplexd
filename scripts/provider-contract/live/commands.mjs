import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const AGENT_ROOT = resolve(ROOT, "agent")
const DEPLOY_TIMEOUT_MS = 10 * 60 * 1_000
const TERMINATE_GRACE_MS = 5_000

function terminateProcessTree(child, signal) {
  if (process.platform !== "win32" && Number.isSafeInteger(child.pid)) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch (error) {
      if (error?.code === "ESRCH") return
    }
  }
  child.kill(signal)
}

export function runCommand(
  command,
  args,
  {
    cwd = ROOT,
    spawnImpl = spawn,
    signal,
    timeoutMs = DEPLOY_TIMEOUT_MS,
    terminateImpl = terminateProcessTree,
  } = {}
) {
  if (signal?.aborted) {
    return Promise.reject(new Error(`${command} was aborted before start`))
  }
  return new Promise((resolvePromise, reject) => {
    let child
    let terminationReason = null
    let timeout = null
    let forceKill = null
    let settled = false

    const finish = (error = null) => {
      if (settled) return
      settled = true
      if (timeout !== null) clearTimeout(timeout)
      if (forceKill !== null) clearTimeout(forceKill)
      signal?.removeEventListener("abort", abort)
      if (error === null) resolvePromise()
      else reject(error)
    }

    const terminate = (reason) => {
      if (terminationReason !== null || settled) return
      terminationReason = reason
      try {
        terminateImpl(child, "SIGTERM")
      } catch {
        // The exit/error event remains the authoritative settlement signal.
      }
      forceKill = setTimeout(() => {
        try {
          terminateImpl(child, "SIGKILL")
        } catch {
          // A missing process is already contained; await the exit event.
        }
      }, TERMINATE_GRACE_MS)
      forceKill.unref?.()
    }

    const abort = () => terminate("aborted")

    try {
      child = spawnImpl(command, args, {
        cwd,
        stdio: ["ignore", "inherit", "inherit"],
        env: process.env,
        detached: process.platform !== "win32",
      })
    } catch {
      finish(new Error(`${command} could not start`))
      return
    }
    child.once("error", () => finish(new Error(`${command} could not start`)))
    child.once("exit", (code, exitSignal) => {
      if (terminationReason !== null) {
        finish(new Error(`${command} ${terminationReason}`))
      } else if (code === 0) {
        finish()
      } else {
        finish(new Error(`${command} failed (${exitSignal ?? `exit ${code}`})`))
      }
    })
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) abort()
    timeout = setTimeout(() => terminate("timed out"), timeoutMs)
    timeout.unref?.()
  })
}

export function createDeployCommands({
  run = runCommand,
  environment = process.env,
} = {}) {
  return {
    deployProbe({ signal } = {}) {
      const organization = environment.PIPECAT_ORGANIZATION
      if (typeof organization !== "string" || organization.trim() === "") {
        throw new Error("PIPECAT_ORGANIZATION is required for probe deployment")
      }
      return run(
        "uv",
        [
          "run",
          "pipecat",
          "cloud",
          "deploy",
          "duplexd-agent",
          "--build-dir",
          ".",
          "--dockerfile",
          "Dockerfile",
          "--min-agents",
          "0",
          "--max-agents",
          "1",
          "--secrets",
          "duplexd-provider-proof",
          "--profile",
          "agent-1x",
          "--organization",
          organization.trim(),
          "--force",
          "--yes",
        ],
        { cwd: AGENT_ROOT, signal, timeoutMs: DEPLOY_TIMEOUT_MS }
      )
    },
  }
}
