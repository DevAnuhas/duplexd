import { ACTIVE_STALE_AFTER_MS, STARTING_STALE_AFTER_MS } from "./constants.ts"

export type StalenessInput = {
  state: string
  createdAt: Date
  lastHeartbeatAt: Date | null
}

export type StaleTransition = {
  state: "incomplete" | "failed"
  endedReason: "agent_lost" | "agent_never_started"
}

export function staleCutoffs(now = new Date()): {
  active: Date
  starting: Date
} {
  return {
    active: new Date(now.getTime() - ACTIVE_STALE_AFTER_MS),
    starting: new Date(now.getTime() - STARTING_STALE_AFTER_MS),
  }
}

/**
 * Derives the state a call should present at a particular instant.
 *
 * Reads use this projection immediately; the external sweeper persists the
 * same transition later. An active row without a heartbeat is deliberately
 * not considered stale: the database predicate this replaces treated NULL as
 * unknown, and manufacturing a lost-agent ending from missing data would be a
 * semantic change rather than a refactor.
 */
export function deriveStaleTransition(
  call: StalenessInput,
  now = new Date()
): StaleTransition | null {
  const cutoffs = staleCutoffs(now)
  if (
    call.state === "active" &&
    call.lastHeartbeatAt !== null &&
    call.lastHeartbeatAt < cutoffs.active
  ) {
    return { state: "incomplete", endedReason: "agent_lost" }
  }

  if (call.state === "starting" && call.createdAt < cutoffs.starting) {
    return {
      state: "failed",
      endedReason: "agent_never_started",
    }
  }

  return null
}
