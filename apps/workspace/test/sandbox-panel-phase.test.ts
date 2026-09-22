import { describe, expect, it } from "vitest"
import type { SandboxBrowserAttempt } from "@/sandbox/browser-contract"
import type { SandboxClientState } from "@/sandbox/client/controller"
import {
  preparationBlock,
  sandboxPanelPhase,
  type PreparationInput,
} from "@/sandbox/client/panel-phase"

/**
 * The panel's phase, not the controller's. The bug these cover is the one the
 * owner hit: the panel offering "Prepare test" — a *second* reservation —
 * while a call was live, because every control rendered in every situation and
 * only the disabled attribute varied.
 */

// Deliberately partial: only the fields the phase derivation reads.
function attempt(
  over: Partial<SandboxBrowserAttempt> = {}
): SandboxBrowserAttempt {
  return {
    state: "prepared",
    resourceState: "not_dispatched",
    ...over,
  } as unknown as SandboxBrowserAttempt
}
function state(over: Partial<SandboxClientState> = {}): SandboxClientState {
  return {
    phase: "idle",
    attempt: null,
    message: null,
    statusKnown: true,
    conflict: null,
    canRetryPreparation: false,
    mediaPhase: "off",
    muted: false,
    ownsController: true,
    deadlines: { reservation: 0, startup: 0, execution: 0 },
    ...over,
  }
}

describe("sandboxPanelPhase", () => {
  it.each([
    ["checking", "connecting"],
    ["starting", "connecting"],
    ["joining", "connecting"],
    ["waiting", "connecting"],
    ["ready", "live"],
    ["reconnecting", "reconnecting"],
    ["finishing", "finishing"],
  ] as const)("maps mediaPhase %s to %s", (mediaPhase, expected) => {
    expect(sandboxPanelPhase(state({ mediaPhase }))).toBe(expected)
  })

  /**
   * The regression that produced the complaint. A prepared attempt record
   * survives for the whole call, so deriving the phase from the attempt alone
   * puts the panel in "prepared" — which is what offered a second reservation
   * mid-call. Connected audio has to win.
   */
  it.each(["ready", "reconnecting", "joining", "waiting"] as const)(
    "lets connected audio (%s) outrank a prepared attempt record",
    (mediaPhase) => {
      const phase = sandboxPanelPhase(
        state({ mediaPhase, attempt: attempt({ state: "prepared" }) })
      )
      expect(phase).not.toBe("prepared")
      expect(phase).not.toBe("idle")
    }
  )

  it("outranks a loading controller with connected audio", () => {
    expect(
      sandboxPanelPhase(state({ phase: "loading", mediaPhase: "ready" }))
    ).toBe("live")
  })

  it("is loading only while nothing is connected", () => {
    expect(sandboxPanelPhase(state({ phase: "loading" }))).toBe("loading")
  })

  it("is idle with no attempt and nothing connected", () => {
    expect(sandboxPanelPhase(state())).toBe("idle")
  })

  it("is prepared for a reserved attempt before any audio", () => {
    expect(sandboxPanelPhase(state({ attempt: attempt() }))).toBe("prepared")
  })

  it.each([
    ["confirmed_stopped", "ended"],
    ["not_dispatched", "canceled"],
    ["not_dispatched", "expired"],
  ] as const)(
    "is finished once resources are released (%s/%s)",
    (resourceState, callState) => {
      expect(
        sandboxPanelPhase(
          state({ attempt: attempt({ resourceState, state: callState }) })
        )
      ).toBe("finished")
    }
  )

  /**
   * An attempt that was dispatched and is not confirmed stopped still owes
   * cleanup. That is the state whose notice used to read "Existing call ·
   * resource cleanup remains required" *during a live call*, because it was the
   * else-branch of a chain the live case also fell through.
   */
  it.each(["dispatched", "stopping", "failed", "start_unknown"] as const)(
    "is cleanup for an unresolved %s attempt with no audio",
    (callState) => {
      expect(
        sandboxPanelPhase(
          state({
            attempt: attempt({
              state: callState,
              resourceState: "stop_requested",
            }),
          })
        )
      ).toBe("cleanup")
    }
  )

  it("reports an error only when there is no attempt to act on", () => {
    expect(sandboxPanelPhase(state({ phase: "error" }))).toBe("error")
    // An attempt still needing cleanup is more actionable than the error.
    expect(
      sandboxPanelPhase(
        state({
          phase: "error",
          attempt: attempt({ state: "dispatched", resourceState: "stop_requested" }),
        })
      )
    ).toBe("cleanup")
  })
})

describe("preparationBlock", () => {
  function input(over: Partial<PreparationInput> = {}): PreparationInput {
    return {
      canRetryPreparation: false,
      busy: false,
      unresolved: false,
      locked: false,
      saving: false,
      conflict: false,
      configurationIssues: 0,
      sampleIssues: 0,
      previewIssues: 0,
      ...over,
    }
  }

  it("permits preparation when nothing blocks it", () => {
    expect(preparationBlock(input())).toBeNull()
  })

  it.each([
    [{ busy: true }, "checking"],
    [{ locked: true }, "checking"],
    [{ unresolved: true }, "active"],
    [{ saving: true }, "saving"],
    [{ conflict: true }, "conflict"],
    [{ configurationIssues: 1 }, "configuration"],
    [{ sampleIssues: 1 }, "samples"],
    [{ previewIssues: 1 }, "preview"],
  ] as const)("blocks on %o with %s", (over, expected) => {
    expect(preparationBlock(input(over))).toBe(expected)
  })

  /**
   * The point of unifying the predicate. Each of these blocked the click
   * handler but not the button, or the button but not the handler. One
   * expression now answers both, so a control that cannot act cannot look
   * pressable.
   */
  it.each([
    { locked: true },
    { sampleIssues: 1 },
    { previewIssues: 1 },
    { saving: true },
  ])("returns a reason, never a bare refusal, for %o", (over) => {
    const block = preparationBlock(input(over))
    expect(block).not.toBeNull()
  })

  it("lets a retryable preparation bypass draft-side blocks it caused", () => {
    // `locked` is true *because* an attempt is unresolved; refusing the retry
    // on that basis would strand the person with no way forward.
    expect(
      preparationBlock(
        input({
          canRetryPreparation: true,
          locked: true,
          unresolved: true,
          sampleIssues: 1,
        })
      )
    ).toBeNull()
  })

  it("still refuses a retry while a request is in flight", () => {
    expect(
      preparationBlock(input({ canRetryPreparation: true, busy: true }))
    ).toBe("checking")
  })
})
