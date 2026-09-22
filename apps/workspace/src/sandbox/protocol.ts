import type { AgentConfigDocument } from "@/data/calls"

export const SANDBOX_PROTOCOL = "sandbox-v1" as const
export const SANDBOX_PROTOCOL_HEADER = "x-duplexd-protocol"
export const SANDBOX_SESSION_HEADER = "x-duplexd-session-id"
export const SANDBOX_BOOT_HEADER = "x-duplexd-boot-id"

/** Negotiation authenticates without claiming configuration or changing ownership. */
export type AgentProtocol = typeof SANDBOX_PROTOCOL | "integration-v1"

export const SANDBOX_EVIDENCE_LIMITS = {
  eventBytes: 8192,
  batchEvents: 64,
  batchBytes: 262144,
  pendingEvents: 1000,
  pendingBytes: 2097152,
  callEvents: 10000,
  callBytes: 8388608,
  pageEvents: 100,
  pageBytes: 131072,
  missingRanges: 32,
} as const

export const SANDBOX_END_REASONS = [
  "client_disconnected",
  "pipeline_error",
  "idle_timeout",
  "user_stopped",
  "startup_deadline",
  "execution_deadline",
  "presence_expired",
  "control_lost",
  "evidence_limit",
  "identity_conflict",
  "start_unknown",
  "startup_failed",
] as const

export type SandboxEvent = {
  seq: number
  at: string
  type: string
  payload: Record<string, unknown>
}
export type SandboxCompletion = {
  endedReason: (typeof SANDBOX_END_REASONS)[number]
  durationSecs: number
  finalSeq: number
  producerLoss: boolean
  truncated: boolean
}
export type SandboxEvidenceState = "unknown" | "partial" | "complete"
export type SandboxEvidenceAck = {
  protocol: typeof SANDBOX_PROTOCOL
  contiguousSeq: number
  missingRanges: [number, number][]
  evidenceState: SandboxEvidenceState
  completionDigest: string | null
  control: SandboxControl
}

/** Safe polling projection, not the producer's raw payload or model trace. */
export type SandboxEventPage = {
  events: Array<{
    cursor: string
    namespace: "agent" | "platform"
    seq: number
    at: string
    type: string
    payload?: Record<string, string | number | boolean>
  }>
  nextCursor: string | null
  hasMore: boolean
  evidence: {
    state: SandboxEvidenceState
    contiguousSeq: number
    finalSeq: number | null
    producerLoss: boolean
    truncated: boolean
    integrityConflict: boolean
    reconciled: boolean
  }
}

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
 * Adapters require independently verified private API/deployment.serviceId
 * binding. Production has no adapter; injection is not release authorization.
 * Start results must contain only a room-scoped browser participant token,
 * never a provider API key or an agent/admin token. A 404, DELETE response,
 * empty listing or elapsed time is NOT terminal proof.
 */
export type SandboxTransport = {
  /**
   * Bound remote work by signal, but await every observed identity's retention
   * before settling (including on abort/failure). No detached retention work:
   * lifecycle cannot release the original slot until start settles durably.
   */
  start(
    input: { callId: string; apiBase: string; agentToken: string },
    signal: AbortSignal,
    context: {
      executionDeadline: Date
      /** Commit identity before validating media; failures deny join/release. */
      retainSession: (sessionId: string) => Promise<void>
    }
  ): Promise<
    | { kind: "started"; join: SandboxJoin }
    | { kind: "definite_no_start" }
    | { kind: "unknown"; reason?: string }
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
