import "./helpers/assistant-form/dom-environment.ts"
import { act, createElement, useEffect } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, expect, it, vi } from "vitest"

const fixture = vi.hoisted(() => ({
  leave: vi.fn(),
  end: vi.fn(async () => {}),
  visibleAgain: vi.fn(),
  /** The controller's media phase for the next render. */
  phase: "ready",
}))
vi.mock("@/sandbox/client/controller", () => ({
  sandboxReleased: () => false,
  SandboxController: class {
    private snapshot = {
      mediaPhase: fixture.phase,
      // What the real controller leaves behind once audio joins; it is never
      // cleared on readiness, so anything that prefers `message` over the
      // phase label shows a stale "waiting" line on a connected call.
      message: "Audio connected. Waiting for persisted agent readiness.",
      attempt: {
        assistantId: "assistant-a",
        callId: "call-a",
        resourceState: "known_running",
      },
      deadlines: { execution: performance.now() + 500_000 },
      outputSilent: false,
      ownsController: true,
      muted: false,
    }
    subscribe = () => () => {}
    getSnapshot = () => this.snapshot
    refresh = async () => {}
    leave = fixture.leave
    end = fixture.end
    // The real controller keeps a call only once it has been ready.
    hidden = vi.fn(() => fixture.phase === "ready")
    visibleAgain = fixture.visibleAgain
    mute = vi.fn()
  },
}))
vi.mock("@/components/sandbox/timeline", () => ({
  LiveSandboxTimeline: () => createElement("div", null, "Conversation stream"),
}))

import {
  PracticeSessionProvider,
  useOptionalPracticeSession,
} from "@/components/sandbox/practice-session"

function Route({ label }: { label: string }) {
  const session = useOptionalPracticeSession()
  useEffect(() => {
    session?.rememberName("assistant-a", "Synthetic assistant")
  }, [session])
  return createElement("div", null, label)
}

let root: Root | undefined
let host: HTMLDivElement | undefined

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  fixture.leave.mockClear()
  fixture.end.mockClear()
  fixture.visibleAgain.mockClear()
  fixture.phase = "ready"
  delete (document as { hidden?: boolean }).hidden
})

it("keeps the active call bar and panel when signed-in route content changes", async () => {
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      createElement(
        PracticeSessionProvider,
        null,
        createElement(Route, { label: "Configure route" })
      )
    )
  })
  expect(host.textContent).toContain("Synthetic assistant")
  expect(host.textContent).toContain("Conversation stream")
  await act(async () => {
    root!.render(
      createElement(
        PracticeSessionProvider,
        null,
        createElement(Route, { label: "Calls route" })
      )
    )
  })
  expect(host.textContent).toContain("Calls route")
  expect(host.textContent).toContain("Synthetic assistant")
  expect(fixture.leave).not.toHaveBeenCalled()
  const collapse = host.querySelector<HTMLButtonElement>(
    '[aria-label="Collapse call panel"]'
  )!
  await act(async () => collapse.click())
  expect(host.textContent).not.toContain("Conversation stream")
  expect(
    host.querySelector('[aria-label="Active practice call"]')
  ).not.toBeNull()
  await act(async () => {
    host!
      .querySelector<HTMLButtonElement>('[aria-label="Open practice call"]')!
      .click()
  })
  expect(host.textContent).toContain("Conversation stream")
  await act(async () => {
    host!
      .querySelector<HTMLButtonElement>(
        '[aria-label="Active practice call"] button:last-child'
      )!
      .click()
  })
  expect(fixture.end).toHaveBeenCalledOnce()
})

async function mountShell() {
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      createElement(
        PracticeSessionProvider,
        null,
        createElement(Route, { label: "Calls route" })
      )
    )
  })
}
async function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => hidden,
  })
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"))
  })
}
const bar = () => host!.querySelector('[aria-label="Active practice call"]')

// #82: the shell owns the call across routes, so it is the shell's hidden-tab
// handler that decides whether switching away ends it.

it("does not leave a ready call when the tab is hidden, and says nothing about stopping", async () => {
  await mountShell()
  expect(bar()?.textContent).toContain("Connected")

  await setHidden(true)

  expect(fixture.leave).not.toHaveBeenCalled()
  expect(fixture.end).not.toHaveBeenCalled()
  expect(host!.textContent).not.toContain("stopped because this tab was hidden")
  // The bar keeps the phase label rather than swapping in a leftover message.
  expect(bar()?.textContent).toContain("Connected")
  expect(bar()?.textContent).not.toContain("Waiting for persisted")
})

it("still leaves a ready call on page hide after the tab was hidden", async () => {
  await mountShell()
  await setHidden(true)
  await act(async () => window.dispatchEvent(new Event("pagehide")))
  expect(fixture.leave).toHaveBeenCalled()
})

it("hands the return to the controller instead of trusting the last phase", async () => {
  await mountShell()
  await setHidden(true)
  await setHidden(false)
  // The shell cannot know whether the call survived the hidden interval; the
  // controller revalidates it with the server.
  expect(fixture.visibleAgain).toHaveBeenCalled()
  expect(fixture.leave).not.toHaveBeenCalled()
})
