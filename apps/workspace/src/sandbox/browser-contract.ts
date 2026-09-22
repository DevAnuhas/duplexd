import type { SandboxAttemptDto } from "./admission"
import type { SandboxJoin } from "./protocol"

/** Fixture/future release wire only. Production always projects disabled. */
export type SandboxBrowserAttempt = Omit<
  SandboxAttemptDto,
  "execution" | "serverTime" | "readyAt"
> & {
  execution: "disabled" | "enabled"
  serverTime: string
  readyAt: string | null
}
export type SandboxStartResponse = { attempt: SandboxBrowserAttempt }
export type SandboxJoinResponse = { join: SandboxJoin }
export type SandboxPresenceResponse = {
  presenceExpiresAt: string
  serverTime: string
}
export type SandboxStopResponse = { attempt: SandboxBrowserAttempt }

/** A terminal call alone does not prove release of provider resources. */
export function sandboxResourcesReleased(
  attempt: SandboxBrowserAttempt
): boolean {
  return (
    attempt.resourceState === "confirmed_stopped" ||
    (attempt.resourceState === "not_dispatched" &&
      (attempt.state === "canceled" || attempt.state === "expired"))
  )
}
