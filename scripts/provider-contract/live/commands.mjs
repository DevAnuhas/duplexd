import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const AGENT_ROOT = resolve(ROOT, "agent")

export function runCommand(
  command,
  args,
  { cwd = ROOT, spawnImpl = spawn } = {}
) {
  return new Promise((resolvePromise, reject) => {
    const child = spawnImpl(command, args, {
      cwd,
      stdio: ["ignore", "inherit", "inherit"],
      env: process.env,
    })
    child.once("error", () => reject(new Error(`${command} could not start`)))
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`${command} failed (${signal ?? `exit ${code}`})`))
    })
  })
}

export function createDeployCommands({
  run = runCommand,
  environment = process.env,
} = {}) {
  return {
    deployProbe() {
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
        { cwd: AGENT_ROOT }
      )
    },
  }
}
