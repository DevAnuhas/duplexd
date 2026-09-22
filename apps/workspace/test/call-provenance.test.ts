import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import {
  CallProvenance,
  preparationLabel,
  WorkspaceCallStateBadge,
} from "@/app/(app)/calls/call-provenance"

const call = {
  source: "sandbox",
  testMode: "practice",
  state: "reserved",
  endedReason: null,
}

describe("workspace call provenance", () => {
  it("labels synthetic history and pre-dispatch states", () => {
    expect(
      renderToStaticMarkup(createElement(CallProvenance, { call }))
    ).toContain("Practice · sample data")
    expect(preparationLabel(call)).toBe("Prepared · voice not started")
    expect(
      preparationLabel({
        ...call,
        state: "failed",
        endedReason: "canceled_before_dispatch",
      })
    ).toBe("Preparation canceled")
    expect(
      preparationLabel({
        ...call,
        state: "failed",
        endedReason: "reservation_expired",
      })
    ).toBe("Preparation expired")
  })
  it("does not infer preparation or clean ending from active/unknown/failed runtime state", () => {
    for (const state of [
      "starting",
      "active",
      "incomplete",
      "failed",
      "ended",
    ]) {
      expect(preparationLabel({ ...call, state })).toBeNull()
      expect(
        renderToStaticMarkup(
          createElement(WorkspaceCallStateBadge, { call: { ...call, state } })
        )
      ).toContain(state)
    }
    expect(preparationLabel({ ...call, source: "integration" })).toBeNull()
  })
})
