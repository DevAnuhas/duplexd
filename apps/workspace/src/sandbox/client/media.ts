import type { SandboxJoin } from "@/sandbox/protocol"

export type SandboxMediaEvent =
  { type: "interrupted" } | { type: "connected" } | { type: "failed" }

/** One gesture, one capture, one room. No adapter may dispatch an agent. */
export interface SandboxMedia {
  prepare(): Promise<void>
  join(join: SandboxJoin): Promise<void>
  mute(muted: boolean): void
  stop(): void
}
export type SandboxMediaFactory = (
  report: (event: SandboxMediaEvent) => void
) => SandboxMedia
