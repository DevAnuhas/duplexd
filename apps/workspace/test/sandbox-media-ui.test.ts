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
}))
vi.mock("@/sandbox/client/daily-media", () => ({
  DailySandboxMedia: class {
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
async function render(observe = false) {
  let current: SandboxBrowserAttempt | null = observe ? prepared() : null
  const requests: string[] = []
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
      else if (path.endsWith("/stop"))
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
function button(label: string) {
  const node = Array.from(container!.querySelectorAll("button")).find(
    (e) => e.textContent === label
  )
  if (!node) throw new Error(`Missing ${label}`)
  return node
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
  await click(button("Prepare test"))
  expect(button("Start voice call").disabled).toBe(false)
  await click(button("Start voice call"))
  expect(container!.textContent).toContain("Waiting for agent readiness")
  expect(container!.textContent).not.toContain("synthetic-token")
  await click(button("Refresh status"))
  expect(
    container!.querySelector('[aria-label="Voice connection"]')!.textContent
  ).toContain("Ready")
  await click(button("Mute microphone"))
  expect(fixture.media.mute).toHaveBeenCalledWith(true)
  expect(button("Unmute microphone").getAttribute("aria-pressed")).toBe("true")
  await click(button("End call"))
  expect(fixture.media.stop).toHaveBeenCalledOnce()
  expect(container!.textContent).toContain(
    "Finishing · cleanup not yet confirmed"
  )
  expect(button("Prepare test").disabled).toBe(true)
  expect(requests.filter((p) => p.endsWith("/start"))).toHaveLength(1)
})
it("observes another tab without taking over or enabling Start", async () => {
  const requests = await render(true)
  expect(button("Start voice call").disabled).toBe(true)
  expect(container!.textContent).toContain("Only its original controller")
  expect(fixture.media.prepare).not.toHaveBeenCalled()
  expect(
    requests.every((p) => !p.endsWith("/start") && !p.endsWith("/join"))
  ).toBe(true)
})
it("stops the injected capture on page hide without reconnecting on return", async () => {
  await render()
  await click(button("Prepare test"))
  await click(button("Start voice call"))
  await act(async () => window.dispatchEvent(new Event("pagehide")))
  expect(fixture.media.stop).toHaveBeenCalledOnce()
  await act(async () => window.dispatchEvent(new Event("focus")))
  expect(fixture.media.prepare).toHaveBeenCalledOnce()
  expect(button("Start voice call").disabled).toBe(true)
})
