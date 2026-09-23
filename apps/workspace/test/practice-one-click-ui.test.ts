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
    constructor() {
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
}

let requests: Array<{ path: string; method: string }> = []
function stubNetwork(network: Network = {}) {
  let current: SandboxBrowserAttempt | null = null
  requests = []
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (url, init) => {
      const path = String(url)
      const method = init?.method ?? "GET"
      requests.push({ path, method })
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
        current = {
          ...current!,
          ...(current?.state === "starting"
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

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  fixture.log = []
  fixture.adapters = []
  fixture.prepare = null
  vi.unstubAllGlobals()
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
  const bar = () =>
    container!.querySelector('[aria-label="Active practice call"]')
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
