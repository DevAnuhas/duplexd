import "./helpers/assistant-form/dom-environment.ts"
import { act, createElement, useEffect } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, expect, it, vi } from "vitest"

const fixture = vi.hoisted(() => ({
  leave: vi.fn(),
  end: vi.fn(async () => {}),
}))
vi.mock("@/sandbox/client/controller", () => ({
  sandboxReleased: () => false,
  SandboxController: class {
    private snapshot = {
      mediaPhase: "ready",
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
