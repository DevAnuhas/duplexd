import type { SandboxJoin } from "@/sandbox/protocol"

export type SandboxMediaEvent =
  | { type: "interrupted" }
  | { type: "connected" }
  | { type: "failed" }
  /** A remote track is attached and playing, and yet no audio is coming out.
   * Reported, never fatal: a false positive that ended a live call would be
   * worse than the confusion it replaces. */
  | { type: "silent" }
  /** Output resumed. The warning must be able to un-say itself. */
  | { type: "audible" }

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
