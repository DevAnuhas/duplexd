import "./helpers/assistant-form/dom-environment.ts"
import { act, createElement, StrictMode, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, expect, it, vi } from "vitest"
import { Sandbox } from "@/app/(app)/assistants/[id]/sandbox/sandbox"
import { AssistantDraftProvider } from "@/app/(app)/assistants/[id]/draft-host"
import { PracticeSessionProvider } from "@/components/sandbox/practice-session"
import { previewFields } from "@/sandbox/client/draft-store"
import type { SandboxBrowserAttempt } from "@/sandbox/browser-contract"
import { click } from "./helpers/assistant-form/render.ts"

/**
 * The one-click Practice call and the shell-owned session, driven through the
 * real `SandboxController` and the real panel. Only the Daily adapter and the
 * network are faked.
 *
 * Each adapter the panel constructs is recorded separately, so a test can say
 * which capture was stopped rather than "some stop happened". `log` is one
 * ordered stream of adapter calls and requests: a reservation made before the
 * permission prompt settled shows up as `POST attempts` ahead of
 * `media.prepare:done`.
 */
const fixture = vi.hoisted(() => ({
  log: [] as string[],
  adapters: [] as Array<{
    prepare: ReturnType<typeof vi.fn>
    join: ReturnType<typeof vi.fn>
    mute: ReturnType<typeof vi.fn>
    stop: ReturnType<typeof vi.fn>
    /** The controller's media listener: lets a test report a Daily event. */
    report: (event: { type: string }) => void
  }>,
  /** Replaced per test to hold or reject the permission prompt. */
  prepare: null as null | (() => Promise<void>),
}))
vi.mock("@/sandbox/client/daily-media", () => ({
  DailySandboxMedia: class {
    prepare = vi.fn(async () => {
      fixture.log.push("media.prepare")
      await (fixture.prepare?.() ?? Promise.resolve())
      fixture.log.push("media.prepare:done")
    })
    join = vi.fn(async () => {
      fixture.log.push("media.join")
    })
    mute = vi.fn()
    stop = vi.fn(() => {
      fixture.log.push("media.stop")
    })
    report: (event: { type: string }) => void
    constructor(report: (event: { type: string }) => void) {
      this.report = report
      fixture.adapters.push(this)
    }
  },
}))
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }))
vi.mock("@/app/(app)/assistants/draft-actions", () => ({
  validateAssistantDraft: vi.fn(async () => ({ issues: [], tools: [] })),
}))

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
function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

type Network = {
  /** Held until the test releases it: the reservation POST in flight. */
  reservation?: Promise<void>
  /** A non-2xx answer to the reservation, e.g. a revision conflict. */
  rejectReservation?: { status: number; body: unknown }
  /** Held until the test releases it: the start POST in flight. */
  start?: Promise<void>
  /** The agent never reports readiness, so the call stays pre-ready. */
  neverReady?: boolean
}

let requests: Array<{ path: string; method: string }> = []
/** The server's view of the attempt. A test can change it behind the
 * browser's back, the way the sweeper or the agent would. */
let current: SandboxBrowserAttempt | null = null
/**
 * A request the server has received but not answered. `index` is its position
 * in `requests`, so a test can tell a renewal sent before the tab was hidden
 * from one sent after it came back. `fail` is a dropped connection.
 */
type Held = {
  path: string
  index: number
  release: () => void
  fail: () => void
}
/** While set, matching requests wait in `held` until the test answers them. */
let hold: ((path: string) => boolean) | null = null
let held: Held[] = []
const isPresence = (path: string) => path.endsWith("/presence")
/** Off: presence answers 200 with a renewed lease but no attempt — a server
 * shape the controller must not treat as silence. */
let presenceCarriesAttempt = true
/**
 * A failure the server (or the network) gives instead of its normal answer:
 * an HTTP status with a body, or `"network"` for a dropped connection. Each
 * fault answers `times` matching requests (once by default), in order, after
 * any hold on the request is released.
 */
type Fault = {
  match: (path: string, method: string) => boolean
  answer: "network" | { status: number; body?: unknown }
  times?: number
}
let faults: Fault[] = []
function fault(entry: Fault) {
  faults.push({ times: 1, ...entry })
}
const isStatusRead = (path: string, method: string) =>
  method === "GET" && path.endsWith("/attempts/attempt")
const isPresenceRenewal = (path: string, method: string) =>
  method === "POST" && isPresence(path)
function stubNetwork(network: Network = {}) {
  current = null
  requests = []
  held = []
  faults = []
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (url, init) => {
      const path = String(url)
      const method = init?.method ?? "GET"
      requests.push({ path, method })
      if (path.endsWith("/csrf")) return Response.json({ token: "csrf" })
      if (hold?.(path)) {
        const answer = deferred()
        held.push({
          path,
          index: requests.length - 1,
          release: answer.resolve,
          fail: () => answer.reject(new TypeError("Failed to fetch")),
        })
        await answer.promise
      }
      const failure = faults.find(
        (f) => (f.times ?? 1) > 0 && f.match(path, method)
      )
      if (failure) {
        failure.times = (failure.times ?? 1) - 1
        if (failure.answer === "network") throw new TypeError("Failed to fetch")
        return Response.json(failure.answer.body ?? {}, {
          status: failure.answer.status,
        })
      }
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
      if (method === "POST" && path.endsWith("/attempts")) {
        fixture.log.push("POST attempts")
        await network.reservation
        if (network.rejectReservation)
          return Response.json(network.rejectReservation.body, {
            status: network.rejectReservation.status,
          })
        current = prepared()
        return Response.json({ attempt: current })
      }
      if (path.endsWith("/start")) {
        fixture.log.push("POST start")
        await network.start
        current = {
          ...current!,
          state: "starting",
          resourceState: "known_running",
          serverTime: iso(),
          startupDeadline: iso(120000),
          executionDeadline: iso(600000),
          presenceExpiresAt: iso(60000),
        }
      } else if (path.endsWith("/join"))
        return Response.json({
          join: {
            sessionId: "synthetic",
            dailyRoom: "https://synthetic.daily.co/room",
            dailyToken: "synthetic-token",
            expiresAt: iso(600000),
          },
        })
      else if (path.endsWith("/presence")) {
        // As the real route does: a stop already requested is not renewable.
        if (current?.stopRequestedAt)
          return Response.json({ code: "expired" }, { status: 409 })
        current = {
          ...current!,
          ...(current?.state === "starting" && !network.neverReady
            ? { state: "active" as const, readyAt: iso() }
            : {}),
          serverTime: iso(),
          presenceExpiresAt: iso(60000),
        }
        return Response.json({
          serverTime: iso(),
          presenceExpiresAt: iso(60000),
          ...(presenceCarriesAttempt ? { attempt: current } : {}),
        })
      } else if (path.endsWith("/stop")) {
        fixture.log.push("POST stop")
        current =
          current?.resourceState === "not_dispatched"
            ? { ...current, state: "canceled", canceledAt: iso() }
            : {
                ...current!,
                state: "stopping",
                resourceState: "stop_requested",
                stopRequestedAt: iso(),
              }
      }
      return Response.json({ attempt: current })
    })
  )
}

function practiceRoute(assistantId = "a", name = "Synthetic practice fixture") {
  return createElement(AssistantDraftProvider, {
    seed: {
      assistantId,
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
        id: assistantId,
        name,
        revision: 1,
        voice: "marin",
        backendModel: "gpt-5.6-luna",
      },
    }),
  })
}
const otherRoute = () => createElement("div", null, "Calls route")

let root: Root | undefined
let container: HTMLDivElement | undefined
/** `shared` mounts the panel the way the signed-in layout does: inside the
 * shell's `PracticeSessionProvider`. Without it, the panel owns a local
 * controller, which is how it is mounted outside the shell. */
function tree(route: ReactElement, shared: boolean) {
  return createElement(
    StrictMode,
    null,
    shared ? createElement(PracticeSessionProvider, null, route) : route
  )
}
async function render(route: ReactElement, shared: boolean) {
  container = document.createElement("div")
  document.body.append(container)
  await act(async () => {
    root = createRoot(container!)
    root.render(tree(route, shared))
  })
  // Draft validation settles before the primary action unblocks.
  await settle(450)
}
async function navigate(route: ReactElement) {
  await act(async () => root!.render(tree(route, true)))
}
async function settle(ms = 0) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}
function maybeButton(label: string) {
  return Array.from(container!.querySelectorAll("button")).find(
    (e) => e.textContent?.trim() === label
  )
}
function button(label: string) {
  const node = maybeButton(label)
  if (!node) throw new Error(`Missing ${label}`)
  return node
}
const posted = (suffix: string) =>
  requests.filter((r) => r.method === "POST" && r.path.endsWith(suffix))
const bar = () =>
  container!.querySelector('[aria-label="Active practice call"]')

/**
 * What Chrome does when the tab is switched away from or another window
 * covers it: `document.hidden` flips and `visibilitychange` fires. Coming
 * back also focuses the window, so return fires both, in that order.
 */
async function setHidden(hidden: boolean, { focus = true } = {}) {
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => hidden,
  })
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (hidden ? "hidden" : "visible"),
  })
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"))
    if (!hidden && focus) window.dispatchEvent(new Event("focus"))
  })
}
/**
 * Copy that tells the person their call ended. Not "Local audio stopped" on
 * its own: the audio check says "Local audio stopped before preparation."
 * about its own microphone test, which is true during a call.
 */
const HIDDEN_STOP_COPY = [
  "stopped because this tab was hidden",
  "stopped because the browser reported this tab as hidden",
  "No voice call is connected",
]
function expectNoStoppedCopy() {
  for (const phrase of HIDDEN_STOP_COPY)
    expect(container!.textContent).not.toContain(phrase)
}
/** A ready call in the shell's session: joined, renewed, agent reported ready. */
async function readySharedCall() {
  await render(practiceRoute(), true)
  await click(button("Start practice call"))
  await settle(50)
  // Control: the rest of each test means nothing unless the call was up, and
  // the stopped-copy assertions mean nothing if that copy was already there.
  expect(bar()?.textContent).toContain("Connected")
  expect(current?.readyAt).not.toBeNull()
  expectNoStoppedCopy()
}
/**
 * Interval timers only — the 15 s presence renewal and the 5 s shell refresh —
 * so a test can fire them on demand. `settle()` still uses a real `setTimeout`.
 * Must run before render: intervals created earlier stay real.
 */
function fakeIntervals() {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
}
async function advanceIntervals(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms)
  })
  await settle(20)
}
/**
 * Intervals that fire only when a test fires them, by period, in the order
 * the test chooses. Fake timers cannot express "the overdue 15 s renewal runs
 * before the 250 ms deadline tick": on a tie they always run the tick first.
 */
type ManualInterval = { callback: () => void; ms: number; cleared: boolean }
let intervals: ManualInterval[] = []
function manualIntervals() {
  intervals = []
  vi.stubGlobal("setInterval", (callback: () => void, ms: number) => {
    const interval = { callback, ms, cleared: false }
    intervals.push(interval)
    return interval
  })
  vi.stubGlobal("clearInterval", (interval?: ManualInterval) => {
    if (interval) interval.cleared = true
  })
}
const PRESENCE_MS = 15_000
const REFRESH_MS = 5_000
const TICK_MS = 250
async function fireIntervals(ms: number) {
  const due = intervals.filter((i) => !i.cleared && i.ms === ms)
  expect(due.length).toBeGreaterThan(0)
  await act(async () => due.forEach((i) => i.callback()))
  await settle(20)
}
/**
 * Timeouts of a second or more wait until the test fires them; shorter ones
 * (React's own, `settle()`) stay real. This reaches a controller retry timer
 * without the test naming its delay, and `clearTimeout` still cancels it, so
 * firing what is pending shows whether a stale retry was left armed.
 * Install after render: only timeouts created afterwards are captured.
 */
type ManualTimeout = { callback: () => void; ms: number; pending: boolean }
let timeouts: ManualTimeout[] = []
function manualTimeouts() {
  timeouts = []
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  vi.stubGlobal(
    "setTimeout",
    (callback: (...args: unknown[]) => void, ms = 0, ...args: unknown[]) => {
      if (ms < 1_000) return realSetTimeout(callback, ms, ...args)
      const timeout = { callback: () => callback(...args), ms, pending: true }
      timeouts.push(timeout)
      return timeout
    }
  )
  vi.stubGlobal("clearTimeout", (timeout?: unknown) => {
    const manual = timeouts.find((t) => t === timeout)
    if (manual) manual.pending = false
    else realClearTimeout(timeout as ReturnType<typeof setTimeout>)
  })
}
/** Fire every captured timeout still pending. Answers how many fired. */
async function fireTimeouts() {
  const due = timeouts.filter((t) => t.pending)
  due.forEach((t) => (t.pending = false))
  await act(async () => due.forEach((t) => t.callback()))
  await settle(20)
  return due.length
}
/** Return to the tab. Answers the index of the first request sent after it. */
async function returnToTab() {
  const since = requests.length
  await setHidden(false)
  await settle(20)
  return since
}
const presenceSince = (since: number) =>
  held.filter((h) => isPresence(h.path) && h.index >= since)
/** On return the controller re-enters `waiting` until a fresh renewal lands.
 * The bar may name the check itself rather than the generic waiting label. */
function expectRevalidating() {
  expect(bar()?.textContent).toMatch(
    /Waiting for assistant|Confirming the call/
  )
  expect(container!.textContent).not.toContain("Connected")
  // Checking is not a reason to drop the call.
  expect(fixture.adapters[0]!.stop).not.toHaveBeenCalled()
  expect(posted("/stop")).toHaveLength(0)
}

/** The sweeper's view: presence lapsed, stop requested. The tab has not heard. */
function serverStopsCall() {
  current = {
    ...current!,
    state: "stopping",
    resourceState: "stop_requested",
    stopRequestedAt: iso(),
    serverTime: iso(),
  }
}
function expectStoppedNotRevived() {
  expect(fixture.adapters[0]!.stop).toHaveBeenCalled()
  expect(container!.textContent).not.toContain("Connected")
  // Returning is not a new call: nothing is re-reserved, re-dispatched or
  // re-joined to paper over the lapse.
  expect(posted("/attempts")).toHaveLength(1)
  expect(posted("/start")).toHaveLength(1)
  expect(fixture.adapters[0]!.join).toHaveBeenCalledOnce()
}

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  fixture.log = []
  fixture.adapters = []
  fixture.prepare = null
  hold = null
  held = []
  current = null
  presenceCarriesAttempt = true
  faults = []
  intervals = []
  timeouts = []
  vi.useRealTimers()
  // The overrides are own properties; deleting them restores jsdom's getters.
  delete (document as { hidden?: boolean }).hidden
  delete (document as { visibilityState?: string }).visibilityState
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

it("reserves nothing when the microphone is refused, and releases the adapter", async () => {
  stubNetwork()
  fixture.prepare = async () => {
    throw new DOMException("Permission denied", "NotAllowedError")
  }
  await render(practiceRoute(), false)

  await click(button("Start practice call"))
  await settle()

  // The whole point of preflighting: a refusal costs no reservation, so the
  // person is not left with a 30 s hold on the one test slot.
  expect(posted("/attempts")).toHaveLength(0)
  expect(container!.querySelector('[role="alert"]')?.textContent).toContain(
    "Microphone or playback could not be opened"
  )
  expect(fixture.adapters).toHaveLength(1)
  expect(fixture.adapters[0]!.stop).toHaveBeenCalledOnce()
  // Not stuck in "Starting practice call…": the person can try again.
  expect(button("Start practice call").disabled).toBe(false)
})

it("opens the microphone before the reservation exists and asks only once", async () => {
  stubNetwork()
  const permission = deferred()
  fixture.prepare = () => permission.promise
  await render(practiceRoute(), false)

  await click(button("Start practice call"))
  // The permission prompt is open. Nothing on the server has been touched yet,
  // and the primary action cannot be pressed a second time underneath it.
  expect(posted("/attempts")).toHaveLength(0)
  expect(container!.textContent).toContain("Starting practice call…")
  expect(maybeButton("Start practice call")?.disabled ?? true).toBe(true)

  await act(async () => permission.resolve())
  await settle()

  expect(fixture.log.indexOf("media.prepare:done")).toBeLessThan(
    fixture.log.indexOf("POST attempts")
  )
  expect(fixture.log.indexOf("POST attempts")).toBeLessThan(
    fixture.log.indexOf("POST start")
  )
  // One adapter, one prompt: the controller took the preflighted adapter
  // rather than building a second one or re-running `prepare()` on it.
  expect(fixture.adapters).toHaveLength(1)
  expect(fixture.adapters[0]!.prepare).toHaveBeenCalledOnce()
  expect(fixture.adapters[0]!.join).toHaveBeenCalledOnce()
  expect(fixture.adapters[0]!.stop).not.toHaveBeenCalled()
  expect(posted("/attempts")).toHaveLength(1)
  expect(posted("/start")).toHaveLength(1)
})

it("releases the open microphone when the reservation is refused", async () => {
  stubNetwork({
    rejectReservation: {
      status: 409,
      body: {
        code: "assistant_changed",
        error: "Saved configuration changed.",
        currentRevision: 2,
      },
    },
  })
  await render(practiceRoute(), false)

  await click(button("Start practice call"))
  await settle()

  expect(posted("/attempts")).toHaveLength(1)
  expect(posted("/start")).toHaveLength(0)
  // Capture was already live when the server said no. Leaving it open would be
  // a hot microphone with no call attached to it.
  expect(fixture.adapters).toHaveLength(1)
  expect(fixture.adapters[0]!.stop).toHaveBeenCalledOnce()
  expect(fixture.adapters[0]!.join).not.toHaveBeenCalled()
})

it("stops capture and reserves nothing when the person leaves during the permission prompt", async () => {
  stubNetwork()
  const permission = deferred()
  fixture.prepare = () => permission.promise
  await render(practiceRoute(), true)

  await click(button("Start practice call"))
  expect(fixture.adapters).toHaveLength(1)

  await navigate(otherRoute())
  expect(container!.textContent).toContain("Calls route")
  expect(fixture.adapters[0]!.stop).toHaveBeenCalled()

  // The browser grants permission after the panel is gone. Nothing that
  // resolves now may reach the server.
  await act(async () => permission.resolve())
  await settle(50)

  expect(posted("/attempts")).toHaveLength(0)
  expect(posted("/start")).toHaveLength(0)
  expect(fixture.adapters[0]!.join).not.toHaveBeenCalled()
  expect(
    container!.querySelector('[aria-label="Active practice call"]')
  ).toBeNull()
})

it("cancels the reservation it made when the person leaves while it is in flight", async () => {
  const reservation = deferred()
  stubNetwork({ reservation: reservation.promise })
  await render(practiceRoute(), true)

  await click(button("Start practice call"))
  expect(posted("/attempts")).toHaveLength(1)

  await navigate(otherRoute())
  await act(async () => reservation.resolve())
  await settle(50)

  // The shell's controller outlives the route, so the reservation the POST
  // produced is still owned here. It is canceled, never started, and never
  // left to squat on the single test slot until it expires.
  expect(posted("/start")).toHaveLength(0)
  expect(posted("/attempts/attempt/stop")).toHaveLength(1)
  expect(fixture.adapters[0]!.stop).toHaveBeenCalled()
  expect(fixture.adapters[0]!.join).not.toHaveBeenCalled()
})

it("keeps a live call through signed-in navigation and still ends it on page hide", async () => {
  stubNetwork()
  await render(practiceRoute(), true)

  await click(button("Start practice call"))
  await settle(50)
  expect(bar()?.textContent).toContain("Synthetic practice fixture")
  expect(bar()?.textContent).toContain("Connected")

  // Configure → Calls → back to Practice. The panel and its draft provider
  // unmount each time; neither may take the shell's call down with it.
  await navigate(otherRoute())
  await settle(50)
  await navigate(practiceRoute())
  await settle(50)
  await navigate(otherRoute())
  await settle(50)

  expect(container!.textContent).toContain("Calls route")
  expect(fixture.adapters).toHaveLength(1)
  expect(fixture.adapters[0]!.stop).not.toHaveBeenCalled()
  expect(posted("/stop")).toHaveLength(0)
  expect(bar()?.textContent).toContain("Connected")
  // The panel's own copy of the call (timer, mute, End) is not rendered on
  // the route; the shell owns them, so there is exactly one End control.
  expect(
    Array.from(container!.querySelectorAll("button")).filter(
      (b) => b.textContent?.trim() === "End"
    )
  ).toHaveLength(1)

  // Persistence across routes must not become persistence across tabs.
  await act(async () => window.dispatchEvent(new Event("pagehide")))
  expect(fixture.adapters[0]!.stop).toHaveBeenCalledOnce()
  expect(posted("/stop")).toHaveLength(1)
})

it("identifies the other assistant's live call without locking this assistant's configuration", async () => {
  stubNetwork()
  await render(practiceRoute(), true)
  await click(button("Start practice call"))
  await settle(50)

  await navigate(practiceRoute("b", "Second assistant"))
  await settle(50)

  expect(container!.textContent).toContain(
    "Practice call with Synthetic practice fixture is active"
  )
  expect(container!.textContent).not.toContain("Talk with Second assistant")
  expect(maybeButton("Start practice call")).toBeUndefined()
  expect(container!.textContent).not.toContain(
    "Editing is locked while a test is being checked"
  )
  expect(posted("/stop")).toHaveLength(0)
})

/*
 * #82: a hidden tab is not a person leaving.
 *
 * Chrome reports the tab hidden on a tab switch and when another window covers
 * it. Once a call is ready, that alone must not stop it: presence renewal is
 * what bounds an abandoned call, and `pagehide` is what ends a closed one.
 * Before readiness nothing has been promised yet, so hiding still abandons the
 * start rather than dispatching an agent into a tab nobody is looking at.
 */

it("keeps a ready shared call through a hidden tab without stopping audio or the call", async () => {
  stubNetwork()
  await readySharedCall()

  await setHidden(true)
  await settle(50)

  expect(fixture.adapters).toHaveLength(1)
  expect(fixture.adapters[0]!.stop).not.toHaveBeenCalled()
  expect(posted("/stop")).toHaveLength(0)
  // Nothing on screen may claim the call stopped while it is still running:
  // not the shell's toast, not its bar, not the route's panel.
  expect(bar()).not.toBeNull()
  expectNoStoppedCopy()
})

it("still ends a ready call when a hidden tab is closed", async () => {
  stubNetwork()
  await readySharedCall()

  // Closing a tab reports it hidden first, then fires `pagehide`. Surviving
  // the first must not mean surviving the second.
  await setHidden(true)
  await act(async () => window.dispatchEvent(new Event("pagehide")))
  await settle(50)

  expect(fixture.adapters[0]!.stop).toHaveBeenCalledOnce()
  expect(posted("/attempts/attempt/stop")).toHaveLength(1)
})

it("on return, waits in Waiting for a fresh presence renewal before saying Connected", async () => {
  fakeIntervals()
  stubNetwork()
  await readySharedCall()
  await setHidden(true)
  await settle(50)

  hold = isPresence
  const since = await returnToTab()

  // Hidden-tab timers are throttled or frozen, so the last renewal the tab saw
  // may be arbitrarily old. Presence is the check, because only presence
  // proves this controller still holds the lease; a status read does not.
  expect(presenceSince(since)).toHaveLength(1)
  expectRevalidating()

  // Whatever else runs on a timer meanwhile — status reads, readiness checks
  // on every deadline tick — sees an active, ready attempt. None of it is the
  // confirmation, so none of it may flip the call back to Connected.
  await advanceIntervals(5_000)
  expectRevalidating()
  // A media blip that recovers re-runs the readiness check, against an
  // attempt that still says ready. The unanswered renewal must still gate it.
  await act(async () => fixture.adapters[0]!.report({ type: "interrupted" }))
  await act(async () => fixture.adapters[0]!.report({ type: "connected" }))
  expectRevalidating()

  hold = null
  await act(async () => presenceSince(since)[0]!.release())
  await settle(50)

  expect(bar()?.textContent).toContain("Connected")
  expect(fixture.adapters[0]!.stop).not.toHaveBeenCalled()
  expect(posted("/stop")).toHaveLength(0)
  expectNoStoppedCopy()
})

it("does not call a previously ready assistant late when confirming after its startup deadline", async () => {
  manualIntervals()
  stubNetwork()
  await readySharedCall()

  // Startup has ended, but the assistant became ready before that deadline.
  // The fixed startup bound remains visible in state after readiness.
  current = { ...current!, startupDeadline: iso(-1_000) }
  await fireIntervals(REFRESH_MS)
  await fireIntervals(1_000)

  await setHidden(true)
  hold = isPresence
  await returnToTab()

  expect(container!.textContent).toContain(
    "Checking the current call with the server"
  )
  expect(container!.textContent).not.toContain(
    "The assistant did not become ready in time"
  )
  expectRevalidating()
})

it("does not take a renewal already in flight when the tab returns as the confirmation", async () => {
  fakeIntervals()
  stubNetwork()
  await readySharedCall()

  // The scheduled renewal goes out and is still unanswered when the tab is
  // hidden. Its answer, whenever it lands, describes the lease before the
  // hidden interval — not after it.
  hold = isPresence
  await advanceIntervals(15_000)
  expect(held.filter((h) => isPresence(h.path))).toHaveLength(1)
  const stale = held[0]!
  await setHidden(true)
  const since = await returnToTab()
  expectRevalidating()

  await act(async () => stale.release())
  await settle(20)
  expectRevalidating()

  // The in-flight request must not swallow the return check: a fresh one is
  // sent, whether at return or as soon as the stale one finishes.
  const fresh = presenceSince(since)
  expect(fresh).toHaveLength(1)
  hold = null
  await act(async () => fresh[0]!.release())
  await settle(50)

  expect(bar()?.textContent).toContain("Connected")
  expect(fixture.adapters[0]!.stop).not.toHaveBeenCalled()
})

it("keeps the call through a brief network failure on the return check, without claiming Connected", async () => {
  fakeIntervals()
  stubNetwork()
  await readySharedCall()
  await setHidden(true)
  await settle(50)

  hold = isPresence
  const since = await returnToTab()
  await act(async () => presenceSince(since)[0]!.fail())
  await settle(20)

  // A dropped request is not a refused lease: the lease this tab holds is
  // still locally valid, so the call stays up — but unconfirmed.
  expectRevalidating()

  // The next scheduled renewal is the retry. When it lands, the call is
  // confirmed again.
  const retrySince = requests.length
  await advanceIntervals(15_000)
  const retry = presenceSince(retrySince)
  expect(retry).toHaveLength(1)
  hold = null
  await act(async () => retry[0]!.release())
  await settle(50)

  expect(bar()?.textContent).toContain("Connected")
  expect(fixture.adapters[0]!.stop).not.toHaveBeenCalled()
  expect(posted("/stop")).toHaveLength(0)
})

it("stops local audio when the server refuses the return check, even with a locally valid lease", async () => {
  stubNetwork()
  await readySharedCall()
  await setHidden(true)
  await settle(50)

  // Stopped server-side while hidden — another tab's End, the call cap, the
  // sweeper — while this tab's own lease clock still has time on it.
  serverStopsCall()
  const since = await returnToTab()
  await settle(50)

  // A 409 is the server saying no, not a dropped packet. Retrying it on a
  // timer until the local lease runs out keeps a hot microphone on a call the
  // server has already stopped, for up to a minute.
  expect(requests.slice(since).some((r) => isPresence(r.path))).toBe(true)
  expectStoppedNotRevived()
})

it("after sleep, stops a call whose lease lapsed even though the monotonic clock stood still", async () => {
  stubNetwork()
  await readySharedCall()
  await setHidden(true)
  await settle(50)

  // A sleeping laptop can pause `performance.now()` while wall time moves on,
  // so the local lease still looks valid. Two minutes of wall time pass.
  const realDateNow = Date.now.bind(Date)
  vi.spyOn(Date, "now").mockImplementation(() => realDateNow() + 120_000)
  // On wake the network is not back yet: renewals go out and never answer.
  // Without a server verdict, only the wall-clock gap can say the lease is
  // gone — the call must not sit on "Confirming…" with a live microphone
  // until the frozen monotonic lease runs out.
  hold = isPresence
  await returnToTab()
  // A few deadline ticks: the drift is only visible between two of them.
  await settle(600)

  expectStoppedNotRevived()
})

it("on return, stops local audio for a call whose lease lapsed while the tab was hidden", async () => {
  stubNetwork()
  await readySharedCall()
  await setHidden(true)
  await settle(50)

  // Chrome throttles hidden-tab timers, so renewals can stop for longer than
  // the 60 s lease. Jump the controller's clock past it, and let the server
  // have swept the call.
  const realNow = performance.now.bind(performance)
  vi.spyOn(performance, "now").mockImplementation(() => realNow() + 61_000)
  serverStopsCall()
  await returnToTab()
  await settle(300)

  expectStoppedNotRevived()
})

it("does not resurface a hidden-tab stop message when a continued call reconnects", async () => {
  stubNetwork()
  await readySharedCall()
  await setHidden(true)
  await setHidden(false)
  await settle(50)
  expect(bar()?.textContent).toContain("Connected")

  // Any "stopped because hidden" reason captured on the way out would be
  // shown the moment the panel leaves its live phase. Reconnecting is that
  // moment, and the call is still running.
  await act(async () => fixture.adapters[0]!.report({ type: "interrupted" }))

  expect(container!.textContent).toContain("Reconnecting")
  expectNoStoppedCopy()
  expect(fixture.adapters[0]!.stop).not.toHaveBeenCalled()
  expect(posted("/stop")).toHaveLength(0)
})

it("hiding during the permission prompt still abandons the start", async () => {
  stubNetwork()
  const permission = deferred()
  fixture.prepare = () => permission.promise
  await render(practiceRoute(), true)
  await click(button("Start practice call"))

  await setHidden(true)
  expect(fixture.adapters[0]!.stop).toHaveBeenCalled()

  await act(async () => permission.resolve())
  await settle(50)

  expect(posted("/attempts")).toHaveLength(0)
  expect(posted("/start")).toHaveLength(0)
  expect(fixture.adapters[0]!.join).not.toHaveBeenCalled()
})

it("hiding while the reservation is in flight cancels it instead of starting", async () => {
  const reservation = deferred()
  stubNetwork({ reservation: reservation.promise })
  await render(practiceRoute(), true)
  await click(button("Start practice call"))
  expect(posted("/attempts")).toHaveLength(1)

  await setHidden(true)
  await act(async () => reservation.resolve())
  await settle(50)

  expect(posted("/start")).toHaveLength(0)
  expect(posted("/attempts/attempt/stop")).toHaveLength(1)
  expect(fixture.adapters[0]!.stop).toHaveBeenCalled()
  expect(fixture.adapters[0]!.join).not.toHaveBeenCalled()
})

it("hiding while the agent is being dispatched stops audio and asks the server to stop", async () => {
  const start = deferred()
  stubNetwork({ start: start.promise })
  await render(practiceRoute(), true)
  await click(button("Start practice call"))
  await settle(20)
  expect(fixture.log).toContain("POST start")

  await setHidden(true)
  expect(fixture.adapters[0]!.stop).toHaveBeenCalled()

  await act(async () => start.resolve())
  await settle(50)

  expect(fixture.adapters[0]!.join).not.toHaveBeenCalled()
  expect(posted("/attempts/attempt/stop").length).toBeGreaterThanOrEqual(1)
})

it("hiding before the agent reports ready still ends the call", async () => {
  stubNetwork({ neverReady: true })
  await render(practiceRoute(), true)
  await click(button("Start practice call"))
  await settle(50)
  // Control: joined and renewing, but the agent never said it was ready.
  expect(fixture.adapters[0]!.join).toHaveBeenCalledOnce()
  expect(bar()?.textContent).toContain("Waiting for assistant")

  await setHidden(true)
  await settle(50)

  expect(fixture.adapters[0]!.stop).toHaveBeenCalledOnce()
  expect(posted("/attempts/attempt/stop")).toHaveLength(1)
  // Here the honest cause is the hidden tab, and it is named.
  expect(container!.textContent).toMatch(/hidden/)
})

it("keeps a valid call when an overdue renewal fails after sleep, before the deadline tick runs", async () => {
  manualIntervals()
  stubNetwork()
  await readySharedCall()

  // Thirty seconds of sleep: wall time moved, the monotonic clock did not.
  // The lease was renewed moments ago for 60 s, so about 30 s of it is left.
  // The tab never reported itself hidden — a lid close need not.
  const realDateNow = Date.now.bind(Date)
  vi.spyOn(Date, "now").mockImplementation(() => realDateNow() + 30_000)

  // On wake the overdue 15 s renewal runs before any deadline tick has seen
  // the drift, and the network is not back: the request rejects.
  hold = isPresence
  await fireIntervals(PRESENCE_MS)
  const overdue = held.filter((h) => isPresence(h.path))
  expect(overdue).toHaveLength(1)
  await act(async () => overdue[0]!.fail())
  await settle(20)

  // A dropped request during a valid lease is not a lost lease. The call
  // stays up, unconfirmed.
  expectRevalidating()
  await fireIntervals(TICK_MS)
  expectRevalidating()

  // The network returns; the next renewal confirms the call.
  hold = null
  await fireIntervals(PRESENCE_MS)
  await fireIntervals(TICK_MS)

  expect(bar()?.textContent).toContain("Connected")
  expect(fixture.adapters[0]!.stop).not.toHaveBeenCalled()
  expect(posted("/stop")).toHaveLength(0)
})

it("does not leave a returned call unconfirmed forever when presence answers without the attempt", async () => {
  fakeIntervals()
  stubNetwork()
  await readySharedCall()
  await setHidden(true)
  await settle(50)

  presenceCarriesAttempt = false
  await returnToTab()
  await advanceIntervals(PRESENCE_MS)

  // Either the renewal counts as the confirmation, or the controller fails
  // closed. Sitting on "Confirming…" with a live microphone is neither.
  const stopped = fixture.adapters[0]!.stop.mock.calls.length > 0
  const connected = bar()?.textContent?.includes("Connected") ?? false
  expect(stopped || connected).toBe(true)
  // And never both: a stopped call is not advertised as connected.
  if (stopped) expect(container!.textContent).not.toContain("Connected")
})

const statusReadsSince = (since: number) =>
  requests
    .slice(since)
    .filter((r) => r.method === "GET" && r.path.endsWith("/attempts/attempt"))

it("shows a server-side stop on a visible live call within one refresh interval", async () => {
  manualIntervals()
  stubNetwork()
  await readySharedCall()

  // Stopped from elsewhere — another tab's End, the cap, the sweeper.
  serverStopsCall()
  await settle(50)
  // Control: nothing has asked yet, so the tab cannot know.
  expect(fixture.adapters[0]!.stop).not.toHaveBeenCalled()

  const since = requests.length
  await fireIntervals(REFRESH_MS)

  expect(statusReadsSince(since)).toHaveLength(1)
  expectStoppedNotRevived()
})

it("skips status reads while hidden but keeps renewing presence", async () => {
  manualIntervals()
  stubNetwork()
  await readySharedCall()
  await setHidden(true)

  const since = requests.length
  await fireIntervals(REFRESH_MS)
  expect(statusReadsSince(since)).toHaveLength(0)

  // The lease is what keeps a hidden call alive; skipping reads must not
  // skip renewals.
  await fireIntervals(PRESENCE_MS)
  expect(requests.slice(since).filter((r) => isPresence(r.path))).toHaveLength(
    1
  )
  expect(fixture.adapters[0]!.stop).not.toHaveBeenCalled()
  expect(posted("/stop")).toHaveLength(0)
})

it("still confirms on return after a renewal succeeded while the tab was hidden", async () => {
  manualIntervals()
  stubNetwork()
  await readySharedCall()
  await setHidden(true)

  // A scheduled renewal lands while the tab is still hidden. It proves the
  // lease at that moment, not at the moment the person comes back.
  const hiddenSince = requests.length
  await fireIntervals(PRESENCE_MS)
  expect(
    requests.slice(hiddenSince).filter((r) => isPresence(r.path))
  ).toHaveLength(1)
  expect(fixture.adapters[0]!.stop).not.toHaveBeenCalled()

  hold = isPresence
  const since = await returnToTab()

  // Return asks again with its own request; the hidden renewal must not have
  // used up the confirmation the return owes.
  expect(presenceSince(since)).toHaveLength(1)
  expectRevalidating()

  hold = null
  await act(async () => presenceSince(since)[0]!.release())
  await settle(50)

  expect(bar()?.textContent).toContain("Connected")
  expect(fixture.adapters[0]!.stop).not.toHaveBeenCalled()
})

it("keeps a call that starts reconnecting while hidden, but still ends it at the reconnect timeout", async () => {
  stubNetwork()
  await readySharedCall()
  await setHidden(true)

  // Daily loses the connection while nobody is looking. Recovery is still
  // allowed: a hidden tab is not a reason to give up on it.
  await act(async () => fixture.adapters[0]!.report({ type: "interrupted" }))
  await settle(300)
  expect(bar()?.textContent).toContain("Reconnecting")
  expect(fixture.adapters[0]!.stop).not.toHaveBeenCalled()
  expect(posted("/stop")).toHaveLength(0)
  expectNoStoppedCopy()

  // But being hidden does not suspend the 20 s recovery bound either. The
  // presence lease (60 s) still has time, so only the reconnect deadline can
  // be what ends it.
  const realNow = performance.now.bind(performance)
  vi.spyOn(performance, "now").mockImplementation(() => realNow() + 21_000)
  await settle(300)

  expect(fixture.adapters[0]!.stop).toHaveBeenCalledOnce()
  expect(posted("/attempts/attempt/stop")).toHaveLength(1)
  expect(bar()?.textContent).not.toContain("Reconnecting")
  expect(container!.textContent).not.toContain("Connected")
  expect(posted("/start")).toHaveLength(1)
  expect(fixture.adapters[0]!.join).toHaveBeenCalledOnce()
})

it("confirms a non-shared panel's call on return from visibility alone, before saying Connected", async () => {
  stubNetwork()
  // Outside the signed-in shell: the panel owns its own controller.
  await render(practiceRoute(), false)
  await click(button("Start practice call"))
  await settle(50)
  expect(container!.textContent).toContain("Connected")
  expect(bar()).toBeNull()

  await setHidden(true)
  await settle(50)
  expect(fixture.adapters[0]!.stop).not.toHaveBeenCalled()
  expect(posted("/stop")).toHaveLength(0)
  expectNoStoppedCopy()

  // Coming back need not focus the window (another window can be moved off
  // it). Visibility alone must start the check.
  hold = isPresence
  const since = requests.length
  await setHidden(false, { focus: false })
  await settle(20)

  expect(presenceSince(since)).toHaveLength(1)
  expect(container!.textContent).not.toContain("Connected")
  expect(fixture.adapters[0]!.stop).not.toHaveBeenCalled()

  hold = null
  await act(async () => presenceSince(since)[0]!.release())
  await settle(50)

  expect(container!.textContent).toContain("Connected")
  expect(fixture.adapters[0]!.stop).not.toHaveBeenCalled()
  expect(posted("/stop")).toHaveLength(0)
})

it("after sleep while hidden, only a renewal sent after return confirms the call, and only once", async () => {
  manualIntervals()
  stubNetwork()
  await readySharedCall()
  await setHidden(true)

  // The laptop sleeps with the tab hidden: 30 s of wall time, no monotonic
  // time, so about 30 s of lease is left. The overdue renewal notices the
  // drift, arms confirmation, and goes out — while still hidden — and hangs.
  const realDateNow = Date.now.bind(Date)
  vi.spyOn(Date, "now").mockImplementation(() => realDateNow() + 30_000)
  hold = isPresence
  await fireIntervals(PRESENCE_MS)
  const hiddenRenewal = held.filter((h) => isPresence(h.path))
  expect(hiddenRenewal).toHaveLength(1)
  expectRevalidating()

  const since = await returnToTab()
  expectRevalidating()

  // The hidden renewal lands. It predates the return, so it renews the lease
  // but cannot confirm the returned tab.
  await act(async () => hiddenRenewal[0]!.release())
  await settle(20)
  expectRevalidating()

  // One renewal begun after the return — queued behind the hidden one if it
  // was not sent at return — is the confirmation.
  const fresh = presenceSince(since)
  expect(fresh).toHaveLength(1)
  hold = null
  await act(async () => fresh[0]!.release())
  await settle(50)

  expect(bar()?.textContent).toContain("Connected")
  expect(fixture.adapters[0]!.stop).not.toHaveBeenCalled()
  expect(posted("/stop")).toHaveLength(0)
  // Confirmed means done: no duplicate renewal chases the confirmation.
  await settle(50)
  expect(requests.slice(since).filter((r) => isPresence(r.path))).toHaveLength(
    1
  )
})

/*
 * #82: an unanswered question is not a "no".
 *
 * A dropped connection or a 5xx on a status read or a lease renewal says
 * nothing about the call: the lease this tab holds is still in force, so the
 * call keeps its audio, says it is unconfirmed, and asks again within that
 * lease. A 4xx is the server answering, and it ends the call at once.
 */

const presenceCount = (since: number) =>
  requests.slice(since).filter((r) => isPresenceRenewal(r.path, r.method))
    .length
/** `state.confirming` as the shell's bar renders it: the controller's own
 * message in place of the connection label. "Waiting for assistant" is a
 * different state and does not count. */
const CONFIRMING = "Confirming the call is still live…"
function expectConfirming() {
  expectRevalidating()
  expect(bar()?.textContent).toContain(CONFIRMING)
}
/** The copy for a lease the server refused as `expired`. It names no cause the
 * tab did not observe — not the hidden tab, not a lost connection. */
const CALL_ENDED = "The call has ended. Local audio stopped; checking cleanup."
/** The controller's retry for an unanswered renewal. */
const RETRY_MS = 2_500
const pendingRetries = () =>
  timeouts.filter((t) => t.pending && t.ms === RETRY_MS)
const UNREACHABLE = [
  { name: "a dropped connection", answer: "network" as const },
  {
    name: "a 503",
    answer: { status: 503, body: { code: "unavailable" } },
  },
]

// The UI already behaved this way before the final #82 fix (the controller
// fell back to confirmation after marking status unknown); these guard it.
it.each(UNREACHABLE)(
  "keeps a visible ready call through a status read that fails with $name, until fresh presence confirms it",
  async ({ answer }) => {
    manualIntervals()
    stubNetwork()
    await readySharedCall()

    fault({ match: isStatusRead, answer })
    hold = isPresence
    const since = requests.length
    await fireIntervals(REFRESH_MS)

    // Control: the failure really was the status read the refresh made.
    expect(statusReadsSince(since)).toHaveLength(1)
    expect(faults[0]!.times).toBe(0)
    // Not knowing is not "ended": the call stays up, stops claiming
    // Connected, and asks the one question that proves the lease.
    expect(presenceSince(since)).toHaveLength(1)
    expectConfirming()
    expect(container!.textContent).not.toContain(CALL_ENDED)
    expect(container!.querySelector('[role="alert"]')).toBeNull()
    expectNoStoppedCopy()

    hold = null
    await act(async () => presenceSince(since)[0]!.release())
    await settle(50)

    expect(bar()?.textContent).toContain("Connected")
    expect(bar()?.textContent).not.toContain(CONFIRMING)
    expect(fixture.adapters[0]!.stop).not.toHaveBeenCalled()
    expect(posted("/stop")).toHaveLength(0)
  }
)

it("stops a visible ready call at once when the status read is refused with a 403", async () => {
  manualIntervals()
  stubNetwork()
  await readySharedCall()

  fault({
    match: isStatusRead,
    answer: { status: 403, body: { code: "attempt_not_owned" } },
  })
  const since = requests.length
  await fireIntervals(REFRESH_MS)

  expect(statusReadsSince(since)).toHaveLength(1)
  // Guard on the fix above: tolerance is for silence, not for a refusal. A
  // 403 must not be turned into "confirming" and a presence retry loop.
  expect(presenceCount(since)).toBe(0)
  expect(container!.textContent).not.toContain(CONFIRMING)
  expectStoppedNotRevived()
  expect(posted("/attempts/attempt/stop")).toHaveLength(1)
})

it.each(UNREACHABLE)(
  "keeps a hidden ready call when a scheduled renewal fails with $name, and retries after 2.5 s",
  async ({ answer }) => {
    manualIntervals()
    stubNetwork()
    await readySharedCall()
    await setHidden(true)
    manualTimeouts()

    fault({ match: isPresenceRenewal, answer })
    const since = requests.length
    await fireIntervals(PRESENCE_MS)

    // Control: the scheduled renewal went out and got the failure.
    expect(presenceCount(since)).toBe(1)
    expect(faults[0]!.times).toBe(0)
    // The lease was renewed for 60 s moments ago and no time has passed, so
    // it is still in force: audio stays up, the call is shown unconfirmed.
    expect(fixture.adapters).toHaveLength(1)
    expectConfirming()
    expect(container!.textContent).not.toContain(CALL_ENDED)
    expectNoStoppedCopy()

    // The retry is its own 2.5 s timer, well inside the lease — not the next
    // scheduled renewal 15 s later. Exactly one is armed.
    expect(pendingRetries()).toHaveLength(1)
    const retrySince = requests.length
    await fireTimeouts()
    expect(presenceCount(retrySince)).toBe(1)
    expect(bar()?.textContent).not.toContain(CONFIRMING)
    expect(fixture.adapters[0]!.stop).not.toHaveBeenCalled()
    expect(posted("/stop")).toHaveLength(0)

    // Confirmed means done: no retry left armed sends a second renewal.
    expect(pendingRetries()).toHaveLength(0)
    const afterConfirm = requests.length
    await fireTimeouts()
    await fireIntervals(TICK_MS)
    expect(presenceCount(afterConfirm)).toBe(0)

    // Coming back still asks once more, and then the call is Connected.
    await returnToTab()
    await settle(50)
    expect(bar()?.textContent).toContain("Connected")
    expect(fixture.adapters[0]!.stop).not.toHaveBeenCalled()
    expect(posted("/stop")).toHaveLength(0)
    expect(posted("/start")).toHaveLength(1)
    expect(fixture.adapters[0]!.join).toHaveBeenCalledOnce()
  }
)

it("disarms the pending retry when a scheduled renewal confirms the call first", async () => {
  manualIntervals()
  stubNetwork()
  await readySharedCall()
  manualTimeouts()

  fault({ match: isPresenceRenewal, answer: "network" })
  await fireIntervals(PRESENCE_MS)
  expectConfirming()
  expect(pendingRetries()).toHaveLength(1)

  // The next scheduled renewal gets there before the retry timer does.
  const since = requests.length
  await fireIntervals(PRESENCE_MS)
  expect(presenceCount(since)).toBe(1)
  expect(bar()?.textContent).toContain("Connected")

  // The retry it beat must not go out as a redundant second renewal.
  expect(pendingRetries()).toHaveLength(0)
  await fireTimeouts()
  expect(presenceCount(since)).toBe(1)
  expect(fixture.adapters[0]!.stop).not.toHaveBeenCalled()
})

it("still ends a hidden call whose renewals keep failing once its lease runs out", async () => {
  manualIntervals()
  stubNetwork()
  await readySharedCall()
  await setHidden(true)
  manualTimeouts()

  // The network never comes back.
  fault({ match: isPresenceRenewal, answer: "network", times: Infinity })
  const since = requests.length
  await fireIntervals(PRESENCE_MS)
  // Control: tolerated, and retried, while the lease is in force.
  await fireTimeouts()
  await fireTimeouts()
  expect(presenceCount(since)).toBe(3)
  expect(fixture.adapters[0]!.stop).not.toHaveBeenCalled()
  expectConfirming()

  // Past the 60 s lease without one successful renewal, "unconfirmed" is no
  // longer honest: the server will have swept the call.
  const realNow = performance.now.bind(performance)
  vi.spyOn(performance, "now").mockImplementation(() => realNow() + 61_000)
  await fireIntervals(TICK_MS)

  expect(fixture.adapters[0]!.stop).toHaveBeenCalledOnce()
  expect(container!.textContent).not.toContain("Connected")
  expect(container!.textContent).not.toContain(CONFIRMING)
  expect(posted("/attempts/attempt/stop")).toHaveLength(1)
  // Stopped means no more retries either.
  const afterStop = requests.length
  await fireTimeouts()
  expect(presenceCount(afterStop)).toBe(0)
})

it("ends a hidden call promptly when a scheduled renewal is refused as expired, and says the call ended", async () => {
  manualIntervals()
  stubNetwork()
  await readySharedCall()
  await setHidden(true)
  manualTimeouts()

  // What the real route answers once the call was stopped elsewhere.
  fault({
    match: isPresenceRenewal,
    answer: { status: 409, body: { code: "expired" } },
  })
  const since = requests.length
  await fireIntervals(PRESENCE_MS)

  expect(presenceCount(since)).toBe(1)
  expect(faults[0]!.times).toBe(0)
  // Refused, not unreachable: no waiting out the rest of the lease.
  expect(fixture.adapters[0]!.stop).toHaveBeenCalledOnce()
  expect(container!.textContent).not.toContain("Connected")
  expect(container!.textContent).not.toContain(CONFIRMING)
  // The honest copy is that the call ended. The tab did not see why, and
  // being hidden is not the reason, so it must not say so.
  expect(container!.textContent).toContain(CALL_ENDED)
  expect(container!.textContent).not.toContain("Presence could not be renewed")
  expectNoStoppedCopy()
  // And nothing keeps asking a server that already said no.
  expect(pendingRetries()).toHaveLength(0)
  await fireTimeouts()
  expect(presenceCount(since)).toBe(1)
  expect(posted("/attempts")).toHaveLength(1)
  expect(posted("/start")).toHaveLength(1)
  expect(fixture.adapters[0]!.join).toHaveBeenCalledOnce()
})
