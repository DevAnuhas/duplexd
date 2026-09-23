import "./helpers/assistant-form/dom-environment.ts"
import { act, createElement, StrictMode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, expect, it, vi } from "vitest"
import { Sandbox } from "@/app/(app)/assistants/[id]/sandbox/sandbox"
import { AssistantDraftProvider } from "@/app/(app)/assistants/[id]/draft-host"
import { previewFields } from "@/sandbox/client/draft-store"
import type { SandboxBrowserAttempt } from "@/sandbox/browser-contract"
import { click } from "./helpers/assistant-form/render.ts"
const fixture = vi.hoisted(() => ({
  media: {
    prepare: vi.fn(async () => {}),
    join: vi.fn(async () => {}),
    mute: vi.fn(),
    stop: vi.fn(),
  },
  /** The adapter's own report callback, so a test can raise a media event the
   * way the real adapter does and watch it reach the panel. */
  report: null as null | ((event: { type: string }) => void),
}))
vi.mock("@/sandbox/client/daily-media", () => ({
  DailySandboxMedia: class {
    constructor(report: (event: { type: string }) => void) {
      fixture.report = report
    }
    prepare = fixture.media.prepare
    join = fixture.media.join
    mute = fixture.media.mute
    stop = fixture.media.stop
  },
}))
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }))
vi.mock("@/app/(app)/assistants/draft-actions", () => ({
  validateAssistantDraft: vi.fn(async () => ({ issues: [], tools: [] })),
}))
let root: Root | undefined
let container: HTMLDivElement | undefined
const iso = (offset = 0) => new Date(Date.now() + offset).toISOString()
function prepared(): SandboxBrowserAttempt {
  return {
    attemptId: "attempt",
    callId: "call",
    assistantId: "a",
    source: "sandbox",
    testMode: "practice",
    configSource: "saved",
    baseAssistantRevision: 1,
    state: "prepared",
    callState: "reserved",
    preparedAt: iso(),
    reservationExpiresAt: iso(30000),
    canceledAt: null,
    expiredAt: null,
    stopRequestedAt: null,
    execution: "enabled",
    resourceState: "not_dispatched",
    startupDeadline: null,
    executionDeadline: null,
    presenceExpiresAt: null,
    serverTime: iso(),
    readyAt: null,
  }
}
/**
 * `readyOnPresenceCall` decides when the agent becomes ready, because both
 * answers are real and the panel has to be right about each.
 *
 * The controller primes presence once inside `start()` and then renews every
 * 15 seconds, and that priming response is how readiness first reaches the
 * browser. An agent that is already up is ready on call 1; a cold one is not,
 * and the panel sits in "Waiting for agent readiness" — the window the owner
 * spent two minutes staring at with no indication of progress. Passing
 * `Infinity` holds it in that window for as long as the test needs, which is
 * the only way to assert the panel does not announce Ready early.
 */
async function render(observe = false, readyOnPresenceCall = 1) {
  let current: SandboxBrowserAttempt | null = observe ? prepared() : null
  const requests: string[] = []
  let presenceCalls = 0
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (url, init) => {
      const path = String(url)
      requests.push(path)
      if (path.endsWith("/csrf")) return Response.json({ token: "csrf" })
      if (path.endsWith("/events"))
        return Response.json({
          events: [],
          nextCursor: null,
          hasMore: false,
          evidence: {
            state: "unknown",
            contiguousSeq: 0,
            finalSeq: null,
            producerLoss: false,
            truncated: false,
            integrityConflict: false,
            reconciled: false,
          },
        })
      if (path.endsWith("/start"))
        current = {
          ...current!,
          state: "starting",
          resourceState: "known_running",
          serverTime: iso(),
          startupDeadline: iso(120000),
          executionDeadline: iso(600000),
          presenceExpiresAt: iso(60000),
        }
      else if (path.endsWith("/join"))
        return Response.json({
          join: {
            sessionId: "synthetic",
            dailyRoom: "https://synthetic.daily.co/room",
            dailyToken: "synthetic-token",
            expiresAt: iso(600000),
          },
        })
      // Presence renews the lease and hands back the attempt, the way the
      // real route does. Without its own branch it fell into the generic POST
      // case below and reset the attempt to a fresh reservation.
      else if (path.endsWith("/presence")) {
        presenceCalls += 1
        current = {
          ...current!,
          // The real route hands back the attempt as it stands, so an agent
          // that became ready shows up here. Returning a permanently
          // "starting" attempt made readiness reachable only by pressing
          // Refresh status, which is not how anyone uses this.
          ...(current?.state === "starting" &&
          presenceCalls >= readyOnPresenceCall
            ? { state: "active" as const, readyAt: iso() }
            : {}),
          serverTime: iso(),
          presenceExpiresAt: iso(60000),
        }
        return Response.json({
          serverTime: iso(),
          presenceExpiresAt: iso(60000),
          attempt: current,
        })
      } else if (path.endsWith("/stop"))
        current = {
          ...current!,
          state: "stopping",
          resourceState: "stop_requested",
          stopRequestedAt: iso(),
        }
      else if (init?.method === "POST") current = prepared()
      else if (current?.state === "starting")
        current = {
          ...current,
          state: "active",
          readyAt: iso(),
          serverTime: iso(),
        }
      return Response.json({ attempt: current })
    })
  )
  container = document.createElement("div")
  document.body.append(container)
  await act(async () => {
    root = createRoot(container!)
    root.render(
      createElement(
        StrictMode,
        null,
        createElement(AssistantDraftProvider, {
          seed: {
            assistantId: "a",
            revision: 1,
            fields: previewFields({
              voice: "marin",
              backendModel: "gpt-5.6-luna",
              tools: "[]",
            }),
            sampleRevision: 0,
            definitions: [],
            suggestedDefinitions: [],
          },
          children: createElement(Sandbox, {
            assistant: {
              id: "a",
              name: "Synthetic media fixture",
              revision: 1,
              voice: "marin",
              backendModel: "gpt-5.6-luna",
            },
          }),
        })
      )
    )
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 450))
  })
  return requests
}
function maybeButton(label: string) {
  return Array.from(container!.querySelectorAll("button")).find(
    (e) => e.textContent === label
  )
}
function button(label: string) {
  const node = maybeButton(label)
  if (!node) throw new Error(`Missing ${label}`)
  return node
}
/**
 * Absent, not merely disabled.
 *
 * The panel used to render every control in every phase and vary only
 * `disabled`, which is how a live call came to offer "Prepare practice call" — a second
 * reservation — next to "End call". Asserting `disabled === true` would pass
 * against that panel, so these assert the control is not in the document.
 */
function expectAbsent(...labels: string[]) {
  for (const label of labels)
    expect(
      maybeButton(label),
      `${label} should not be in the document`
    ).toBeUndefined()
}
afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})
it("keeps enabled media behind a gesture, waits for readiness, mutes and ends locally", async () => {
  const requests = await render()
  expect(fixture.media.prepare).not.toHaveBeenCalled()
  fixture.media.prepare.mockImplementationOnce(async () => {
    expect(requests.some((path) => path.endsWith("/attempts"))).toBe(false)
  })
  await click(button("Start practice call"))
  expect(fixture.media.prepare).toHaveBeenCalledOnce()
  expect(container!.textContent).not.toContain("synthetic-token")
  // Readiness arrives on its own, through presence. Nobody should have to press
  // anything to stop waiting — the old flow only left this state when the
  // person clicked Refresh status.
  expect(container!.textContent).toContain("Connected")
  await click(button("Mute microphone"))
  expect(fixture.media.mute).toHaveBeenCalledWith(true)
  expect(button("Unmute microphone").getAttribute("aria-pressed")).toBe("true")
  await click(button("End call"))
  expect(fixture.media.stop).toHaveBeenCalledOnce()
  expect(container!.textContent).toContain("Ending call…")
  expectAbsent(
    "Prepare practice call",
    "Start practice call",
    "Cancel preparation"
  )
  expect(requests.filter((p) => p.endsWith("/start"))).toHaveLength(1)
})

it("offers one action while a call is live, and never a second reservation", async () => {
  await render()
  await click(button("Start practice call"))
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 450))
  })
  expect(container!.textContent).toContain("Connected")
  // The complaint this ticket started from: mid-call the panel showed Prepare
  // test, Cancel preparation, Refresh status, Start practice call, Mute and End
  // call at once, and offered to prepare another test during a live call.
  expectAbsent(
    "Prepare practice call",
    "Start practice call",
    "Cancel preparation",
    "Refresh status",
    "Retry preparation",
    "Start another call"
  )
  expect(button("End call")).toBeDefined()
  expect(button("Mute microphone")).toBeDefined()
  // The stale notice that rendered above all of it, from an else-branch a
  // dispatched attempt also reached.
  expect(container!.textContent).not.toContain("resource cleanup remains")
})

it("shows the connection stage without a countdown or false readiness", async () => {
  // The agent never reports ready, so the panel stays in the window the owner
  // sat through for two minutes with nothing on screen changing.
  await render(false, Infinity)
  await click(button("Start practice call"))

  expect(container!.textContent).toContain("Waiting for agent readiness")
  // It must not claim readiness the server has not reported.
  expect(container!.textContent).not.toContain("Connected")
  // The current stage explains the wait without an unhelpful countdown.
  expect(container!.textContent).not.toMatch(/up to \d+:\d\d left/)

  // One action, and it is the one that stops a call.
  expect(button("End call")).toBeDefined()
  expectAbsent(
    "Prepare practice call",
    "Start practice call",
    "Cancel preparation",
    "Refresh status",
    "Mute microphone"
  )
})

it("warns about silent output without ending the call, and withdraws it", async () => {
  await render()
  await click(button("Start practice call"))
  expect(container!.textContent).toContain("Connected")
  expect(container!.textContent).not.toContain("Check your output device")

  await act(async () => fixture.report!({ type: "silent" }))

  expect(container!.textContent).toContain("Check your output device")
  // Advisory, not fatal. The call is still live and still endable.
  expect(container!.textContent).toContain("Connected")
  expect(fixture.media.stop).not.toHaveBeenCalled()
  expect(button("End call")).toBeDefined()
  expect(button("Mute microphone")).toBeDefined()

  // It has to be able to un-say itself; a sticky warning after recovery is
  // another way for a working call to look broken.
  await act(async () => fixture.report!({ type: "audible" }))

  expect(container!.textContent).not.toContain("Check your output device")
})

it("does not let a silent-output report disturb a reconnecting call", async () => {
  // The controller's event handler treats anything that is not "failed" or
  // "interrupted" as "connected". Routed through that branch, an output
  // advisory would silently clear a reconnection in progress.
  await render()
  await click(button("Start practice call"))
  await act(async () => fixture.report!({ type: "interrupted" }))
  expect(container!.textContent).toContain("Reconnecting…")

  await act(async () => fixture.report!({ type: "silent" }))

  expect(container!.textContent).toContain("Reconnecting…")
})

it("explains why a call still waiting for the agent stopped on tab hide", async () => {
  await render(false, Infinity)
  await click(button("Start practice call"))
  await act(async () => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => true,
    })
    document.dispatchEvent(new Event("visibilitychange"))
  })
  expect(fixture.media.stop).toHaveBeenCalled()
  expect(container!.textContent).toContain(
    "Practice stopped before the call connected because this tab was hidden"
  )
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => false,
  })
})
it("observes another tab without taking over or enabling Start", async () => {
  const requests = await render(true)
  expect(button("Start prepared call").disabled).toBe(true)
  expect(container!.textContent).toContain("Only its original controller")
  expect(fixture.media.prepare).not.toHaveBeenCalled()
  expect(
    requests.every((p) => !p.endsWith("/start") && !p.endsWith("/join"))
  ).toBe(true)
})
it("stops the injected capture on page hide without reconnecting on return", async () => {
  await render()
  await click(button("Start practice call"))
  await act(async () => window.dispatchEvent(new Event("pagehide")))
  expect(fixture.media.stop).toHaveBeenCalledOnce()
  await act(async () => window.dispatchEvent(new Event("focus")))
  expect(fixture.media.prepare).toHaveBeenCalledOnce()
  // The attempt was dispatched and is not confirmed stopped, so what is owed
  // is cleanup — not another call. Asserting a *disabled* Start button would
  // have accepted a panel that still offered one.
  expectAbsent("Start practice call", "Start prepared call")
  expect(button("Retry stop")).toBeDefined()
})
