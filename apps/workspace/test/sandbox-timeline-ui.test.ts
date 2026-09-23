import "./helpers/assistant-form/dom-environment.ts"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  SandboxTimeline,
  LiveSandboxTimeline,
} from "@/components/sandbox/timeline"
import type { TimelineState } from "@/sandbox/client/timeline"

let root: Root | undefined
let container: HTMLDivElement | undefined
function event(
  seq: number,
  patch: Partial<TimelineState["events"][number]> = {}
): TimelineState["events"][number] {
  return {
    namespace: "agent",
    seq,
    cursor: `synthetic-${seq}`,
    at: "2026-09-22T12:00:00Z",
    type: "transcript_user",
    payload: { text: `Synthetic text ${seq}` },
    ...patch,
  }
}
function state(patch: Partial<TimelineState> = {}): TimelineState {
  return {
    events: [],
    evidence: {
      state: "partial",
      contiguousSeq: 0,
      finalSeq: null,
      producerLoss: false,
      truncated: false,
      integrityConflict: false,
      reconciled: false,
    },
    loading: false,
    error: null,
    limited: false,
    hasMore: false,
    updatedAt: null,
    ...patch,
  }
}
async function render(value: TimelineState, onRefresh = vi.fn()) {
  if (!container) {
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  }
  await act(async () => {
    root!.render(createElement(SandboxTimeline, { state: value, onRefresh }))
  })
  return container
}
function button(label: string) {
  const found = [...container!.querySelectorAll("button")].find(
    (node) => node.textContent === label
  )
  if (!found) throw new Error(`Missing button ${label}`)
  return found
}
afterEach(() => {
  act(() => {
    root?.unmount()
  })
  container?.remove()
  root = undefined
  container = undefined
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("safe and stable timeline DOM", () => {
  it("renders adversarial transcripts literally and tool samples without leaking raw fields or implying business success", async () => {
    const literal =
      '<img src="x" onerror="alert(1)"><script>synthetic()</script>\nSecond line'
    const node = await render(
      state({
        events: [
          event(1, { payload: { text: literal, secret: "SYNTHETIC_SECRET" } }),
          event(2, {
            type: "tool_finished",
            payload: {
              tool: "<b>lookup</b>",
              outcome: "failure",
              durationMs: 12,
              practiceScenario: "success",
              practiceSelectedStatus: 200,
              arguments: "SYNTHETIC_SECRET",
              result: "SYNTHETIC_SECRET",
            },
          }),
          event(3, { type: "unknown", payload: { text: "SYNTHETIC_SECRET" } }),
        ],
      })
    )
    expect(node.querySelector("img, script, b")).toBeNull()
    expect(node.textContent).toContain(literal)
    expect(node.textContent).not.toContain("SYNTHETIC_SECRET")
    expect(node.textContent).toContain("Practice · sample data")
    expect(node.textContent).toContain(
      "<b>lookup</b>: Sample delivery failed · 12 ms · success scenario · selected sample HTTP 200"
    )
    expect(node.textContent).toContain(
      "Sample selection is not business success"
    )
    expect(node.textContent).toContain("Activity recorded")
  })

  it("retains focus and scroll position while reading older events, with an explicit jump back to latest", async () => {
    const node = await render(state({ events: [event(1)] }))
    const viewport = node.querySelector<HTMLDivElement>(
      '[aria-label="Timeline events"]'
    )!
    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, value: 1200 },
      clientHeight: { configurable: true, value: 400 },
    })
    viewport.scrollTop = 100
    viewport.focus()
    await act(async () => {
      viewport.dispatchEvent(new Event("scroll", { bubbles: true }))
    })
    expect(button("Jump to latest")).toBeDefined()
    await render(state({ events: [event(1), event(2)] }))
    expect(document.activeElement).toBe(viewport)
    expect(viewport.scrollTop).toBe(100)
    await act(async () => {
      button("Jump to latest").click()
    })
    expect(viewport.scrollTop).toBe(1200)
    expect(document.activeElement).toBe(viewport)
    expect(node.textContent).not.toContain("Jump to latest")
    Object.defineProperty(viewport, "scrollHeight", {
      configurable: true,
      value: 1500,
    })
    await render(state({ events: [event(1), event(2), event(3)] }))
    expect(viewport.scrollTop).toBe(1500)
    expect(document.activeElement).toBe(viewport)
  })

  it("keeps loaded history visible through errors and exposes all loss/limit states without declaring a clean ending", async () => {
    const base = state()
    const node = await render(
      state({
        events: [event(1)],
        limited: true,
        hasMore: true,
        error:
          "Sign in again to load more evidence. Previously loaded events are kept.",
        evidence: {
          ...base.evidence!,
          producerLoss: true,
          truncated: true,
          integrityConflict: true,
          reconciled: true,
        },
      })
    )
    expect(node.textContent).toContain("Synthetic text 1")
    expect(node.querySelector('[role="alert"]')!.textContent).toContain(
      "Previously loaded events are kept"
    )
    expect(node.textContent).toContain("Display limit reached")
    expect(node.textContent).toContain("Some evidence was lost or truncated")
    expect(node.textContent).toContain("Conflicting evidence was reported")
    expect(node.textContent).toContain(
      "without claiming an agent-confirmed ending"
    )
    expect(button("Refresh evidence").disabled).toBe(true)
    expect(node.textContent).toContain("Partial record")
    expect(
      node.querySelector('[role="status"]')!.getAttribute("aria-live")
    ).toBe("polite")
  })

  it("shows empty evidence honestly, refreshes on demand, and marks stale partial evidence", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-09-22T12:00:00Z"))
    const refresh = vi.fn()
    const node = await render(state({ updatedAt: Date.now() }), refresh)
    expect(node.textContent).toContain("No persisted events yet")
    expect(node.textContent).toContain("Preparing a test does not start voice")
    await act(async () => {
      button("Refresh evidence").click()
    })
    expect(refresh).toHaveBeenCalledOnce()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(11000)
    })
    expect(node.textContent).toContain("Updates delayed")
    await render(state({ loading: true }))
    expect(button("Refresh evidence").disabled).toBe(true)
    expect(node.querySelector('[role="status"]')!.textContent).toContain(
      "Updating"
    )
  })
})

it("polls remaining pages of complete evidence until all 400 events load", async () => {
  vi.useFakeTimers()
  let pages = 0
  const fetcher = vi.fn<typeof fetch>(async () => {
    const page = ++pages
    return Response.json({
      events: Array.from({ length: 100 }, (_, i) =>
        event((page - 1) * 100 + i + 1)
      ),
      nextCursor: `cursor-${page}`,
      hasMore: page < 4,
      evidence: {
        ...state().evidence,
        state: "complete",
        contiguousSeq: 400,
        finalSeq: 400,
      },
    })
  })
  vi.stubGlobal("fetch", fetcher)
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(
      createElement(LiveSandboxTimeline, { callId: "synthetic-completed-call" })
    )
  })
  expect(fetcher).toHaveBeenCalledTimes(3)
  expect(container.querySelectorAll("li")).toHaveLength(300)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000)
  })
  expect(fetcher).toHaveBeenCalledTimes(4)
  expect(container.querySelectorAll("li")).toHaveLength(400)
  expect(String(fetcher.mock.calls[3]?.[0])).toContain("after=cursor-3")
  await act(async () => {
    await vi.advanceTimersByTimeAsync(9000)
  })
  expect(fetcher).toHaveBeenCalledTimes(4)
})
