import { sandboxResourcesReleased } from "@/sandbox/browser-contract"
import type { SandboxClientState } from "./controller"

/**
 * What the Sandbox panel is *for* right now.
 *
 * The panel used to render every control in every situation and merely disable
 * the ones that did not apply, which is how a live call came to offer "Prepare
 * test", "Cancel preparation", "Refresh status", "Mute", "End call" and "Start
 * voice call" at the same time. Deriving a single phase here — rather than
 * spreading `disabled={...}` expressions through the markup — is what lets the
 * panel show one primary action and drop the rest.
 *
 * A call in progress outranks everything else: whatever the attempt record
 * says, if audio is connected the only question that matters is how to end it.
 */
export type SandboxPanelPhase =
  | "loading"
  | "idle"
  | "prepared"
  | "connecting"
  | "live"
  | "reconnecting"
  | "finishing"
  | "cleanup"
  | "finished"
  | "error"

export function sandboxPanelPhase(state: SandboxClientState): SandboxPanelPhase {
  if (state.mediaPhase === "ready") return "live"
  if (state.mediaPhase === "reconnecting") return "reconnecting"
  if (state.mediaPhase === "finishing") return "finishing"
  if (state.mediaPhase !== "off") return "connecting"
  if (state.phase === "loading") return "loading"
  if (state.attempt !== null) {
    if (sandboxResourcesReleased(state.attempt)) return "finished"
    if (state.attempt.state === "prepared") return "prepared"
    return "cleanup"
  }
  if (state.phase === "error") return "error"
  return "idle"
}

/**
 * Why preparation cannot start, or `null` when it can.
 *
 * One expression, two consumers: the button's `disabled` and the click handler's
 * own guard. They used to be separate predicates that happened to agree — the
 * handler checked `locked` and the parsed sample/preview issues, the button
 * checked `draft.saving`, and neither checked all of it. Every state I could
 * actually construct was caught by both, so this is not a repair of a live bug;
 * it is the removal of the drift that would eventually produce one, where a
 * button looks pressable, stops your local audio, and then silently does
 * nothing.
 *
 * Returning the reason rather than a boolean is what lets the panel say why
 * instead of presenting a dead control.
 */
export type PreparationBlock =
  | "checking"
  | "saving"
  | "conflict"
  | "configuration"
  | "samples"
  | "preview"
  | "active"

export type PreparationInput = {
  canRetryPreparation: boolean
  busy: boolean
  unresolved: boolean
  locked: boolean
  saving: boolean
  conflict: boolean
  configurationIssues: number
  sampleIssues: number
  previewIssues: number
}

export function preparationBlock(
  input: PreparationInput
): PreparationBlock | null {
  // Retrying a preparation the server already accepted is allowed to bypass the
  // draft-side checks: the snapshot it retries was validated when it was taken,
  // and the draft may have been locked by that very attempt.
  if (input.canRetryPreparation) return input.busy ? "checking" : null
  if (input.busy || input.locked) return "checking"
  if (input.unresolved) return "active"
  if (input.saving) return "saving"
  if (input.conflict) return "conflict"
  if (input.configurationIssues > 0) return "configuration"
  if (input.sampleIssues > 0) return "samples"
  if (input.previewIssues > 0) return "preview"
  return null
}

/** Said to the person, not about the system. */
export const preparationBlockMessage: Record<PreparationBlock, string> = {
  checking: "Checking the current test status…",
  saving: "Saving your changes. Preparation starts once that finishes.",
  conflict:
    "This assistant changed in another tab. Reload before preparing a test.",
  configuration:
    "Fix the configuration issues above before preparing a test.",
  samples: "Fix the sample responses above before preparing a test.",
  preview:
    "Fix the unsaved preview above, or test the saved configuration instead.",
  active: "Finish or cancel the current test before preparing another.",
}
