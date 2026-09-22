import type { AgentConfigDocument } from "@/data/calls"

export const SANDBOX_PROTOCOL = "sandbox-v1" as const
export const SANDBOX_PROTOCOL_HEADER = "x-duplexd-protocol"
export const SANDBOX_SESSION_HEADER = "x-duplexd-session-id"
export const SANDBOX_BOOT_HEADER = "x-duplexd-boot-id"

export const SANDBOX_LIMITS = {
  dispatchMs: 15_000,
  startupMs: 120_000,
  executionMs: 600_000,
  presenceMs: 60_000,
  pollIntervalMs: 3_000,
  controlLossTimeoutMs: 30_000,
  gracefulStopMs: 10_000,
  reportingGraceMs: 60_000,
} as const

export type SandboxOwner = { sessionId: string; bootId: string }
export type SandboxControl = {
  stopRequested: boolean
  stopReason: string | null
  startupDeadline: string
  executionDeadline: string
  presenceExpiresAt: string
  serverTime: string
  pollIntervalMs: 3000
  controlLossTimeoutMs: 30000
  gracefulStopMs: 10000
  reportingGraceMs: 60000
}
export type SandboxConfig = {
  protocol: typeof SANDBOX_PROTOCOL
  owner: SandboxOwner
  config: AgentConfigDocument
  control: SandboxControl
}

/** Bounded opaque identities, never paths, URLs or authority supplied by a browser. */
export function validSandboxIdentity(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value)
}

export type SandboxJoin = {
  sessionId: string
  dailyRoom: string
  dailyToken: string
  expiresAt: string
}

export type SandboxBinding = {
  organizationId: string
  serviceId: string
  deploymentId: string
  agentName: string
}

/**
 * No live adapter exists. A future adapter must verify the private API contract
 * and independent deployment.serviceId binding before implementing this seam.
 * Start results must contain only a room-scoped browser participant token,
 * never a provider API key or an agent/admin token. A 404, DELETE response,
 * empty listing or elapsed time is NOT terminal proof.
 */
export type SandboxTransport = {
  start(
    input: { callId: string; apiBase: string; agentToken: string },
    signal: AbortSignal
  ): Promise<
    | { kind: "started"; join: SandboxJoin }
    | { kind: "definite_no_start" }
    | { kind: "unknown" }
  >
  read(
    sessionId: string,
    signal: AbortSignal
  ): Promise<
    | {
        kind: "session"
        sessionId: string
        binding: SandboxBinding
        state: "running" | "stopped"
      }
    | { kind: "unknown" | "forbidden" | "not_found" }
  >
  stop(sessionId: string, signal: AbortSignal): Promise<void>
}
