import { spawn } from "node:child_process"

const NGROK_API = "http://127.0.0.1:4040/api/tunnels"

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export function createNgrokTunnel({
  spawnImpl = spawn,
  fetchImpl = fetch,
  pollDelay = delay,
} = {}) {
  let process = null
  let publicUrl = null

  async function open(port) {
    if (process !== null) throw new Error("ngrok tunnel is already running")
    const upstream = `http://127.0.0.1:${port}`
    process = spawnImpl(
      "ngrok",
      ["http", upstream, "--log", "stdout", "--log-format", "json"],
      { stdio: ["ignore", "ignore", "ignore"] }
    )
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (process.exitCode !== null)
        throw new Error("ngrok exited before becoming ready")
      try {
        const response = await fetchImpl(NGROK_API, {
          signal: AbortSignal.timeout(1_000),
        })
        const value = await response.json()
        const httpsTunnel = value?.tunnels?.find(
          (tunnel) =>
            typeof tunnel?.public_url === "string" &&
            tunnel.public_url.startsWith("https://") &&
            tunnel.config?.addr === upstream
        )
        if (httpsTunnel !== undefined) {
          publicUrl = new URL(httpsTunnel.public_url).origin
          return `${publicUrl}/probe-events`
        }
      } catch {
        // Keep polling the loopback ngrok API within the bounded startup window.
      }
      await pollDelay(250)
    }
    await close()
    throw new Error("ngrok did not expose an HTTPS tunnel")
  }

  async function close() {
    if (process === null) return
    const child = process
    process = null
    publicUrl = null
    if (child.exitCode === null) {
      child.kill("SIGTERM")
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        delay(5_000).then(() => child.kill("SIGKILL")),
      ])
    }
  }

  return { open, close, publicUrl: () => publicUrl }
}
