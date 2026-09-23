import "./helpers/assistant-form/dom-environment.ts"

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, createElement, StrictMode } from "react"
import { createRoot, type Root } from "react-dom/client"

import {
  Sandbox,
  type SandboxProps,
} from "@/app/(app)/assistants/[id]/sandbox/sandbox"
import { rileyPracticeTemplate } from "@/practice/riley"
import { click } from "./helpers/assistant-form/render.ts"

const validation = vi.hoisted(() => ({
  issues: [] as Array<{ field: string; message: string }>,
}))
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }))
vi.mock("@/app/(app)/assistants/draft-actions", () => ({
  validateAssistantDraft: vi.fn(async () => ({
    issues: validation.issues,
    tools: [],
  })),
}))
import { AssistantDraftProvider } from "@/app/(app)/assistants/[id]/draft-host"
import { previewFields } from "@/sandbox/client/draft-store"

let root: Root | undefined
let container: HTMLDivElement | undefined
const initial: SandboxProps = {
  assistant: {
    id: "assistant-a",
    name: "Riley — fictional sample",
    revision: 3,
    voice: "marin",
    backendModel: "gpt-5.6-luna",
  },
}
function stubFetch() {
  const calls: Array<{ path: string; options?: RequestInit }> = []
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (path, options) => {
      calls.push({ path: String(path), options })
      if (String(path).endsWith("/csrf"))
        return Response.json({ token: "csrf" })
      if (options?.method === "POST")
        return Response.json({
          attempt: {
            attemptId: "attempt-a",
            callId: "call-a",
            assistantId: "assistant-a",
            state: String(path).endsWith("/stop") ? "canceled" : "prepared",
            callState: "reserved",
            source: "sandbox",
            testMode: "practice",
            configSource: "saved",
            baseAssistantRevision: 3,
            preparedAt: "2026-09-22T09:00:00Z",
            reservationExpiresAt: "2026-09-22T09:00:30Z",
            canceledAt: null,
            expiredAt: null,
            stopRequestedAt: null,
            execution: "disabled",
            resourceState: "not_dispatched",
            startupDeadline: null,
            executionDeadline: null,
            presenceExpiresAt: null,
          },
        })
      return Response.json({ attempt: null })
    })
  )
  return calls
}
async function render(
  props = initial,
  issues: Array<{ field: string; message: string }> = []
) {
  validation.issues = issues
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
            assistantId: props.assistant.id,
            revision: props.assistant.revision,
            fields: previewFields({
              voice: "marin",
              backendModel: "gpt-5.6-luna",
              tools: "[]",
            }),
            sampleRevision: 0,
            definitions: [],
            suggestedDefinitions: rileyPracticeTemplate().samples,
          },
          children: createElement(Sandbox, props),
        })
      )
    )
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 450))
  })
}
function button(text: string) {
  const found = Array.from(container!.querySelectorAll("button")).find(
    (item) => item.textContent === text
  )
  if (!found) throw new Error(`Missing button: ${text}`)
  return found
}
/**
 * "This action does not apply right now" is absence, not a disabled control.
 *
 * The panel used to render every control in every phase and disable the ones
 * that did not apply, which is how a live call came to offer Prepare, Cancel,
 * Refresh, Mute, End and Start at once. `panel-phase.ts` replaced that with one
 * action per phase, so these assertions check that the control is gone — and,
 * where a swap is the point, that the action which replaced it is present.
 * Asserting only absence would also pass if the panel failed to render at all.
 */
function absent(text: string) {
  return Array.from(container!.querySelectorAll("button")).every(
    (item) => item.textContent !== text
  )
}
afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  vi.unstubAllGlobals()
})

describe("Sandbox workspace UI", () => {
  it("mounts in StrictMode without a mutation or media request and claims nothing about voice before the server answers", async () => {
    const calls = stubFetch()
    const microphone = vi.fn()
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: microphone } })
    await render()
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((call) => call.options?.method === "GET")).toBe(true)
    expect(microphone).not.toHaveBeenCalled()
    // No attempt yet: the primary Start is available, while the prepared-call
    // action is absent. Neither starts on mount.
    expect(absent("Start prepared call")).toBe(true)
    expect(button("Start practice call").disabled).toBe(false)
    // The execution gate is a report of what the server said, so it waits for
    // the server to say it. The condition used to be
    // `state.attempt?.execution !== "enabled"`, which is also true when there
    // is no attempt — so a fresh page announced that voice calls were disabled
    // before it had asked. The gate's presence is covered below, once an
    // attempt exists.
    expect(container!.textContent).not.toContain(
      "Voice calls are not available yet"
    )
    expect(container!.querySelector('[aria-current="page"]')?.textContent).toBe(
      "Practice"
    )
  })
  it("prepares the selected sample scenario, freezes controls and cancels through the same API", async () => {
    const calls = stubFetch()
    await render()
    await click(container!.querySelector('input[value="unavailable"]')!)
    await click(button("Prepare without calling"))
    const prepare = calls.find(
      (call) =>
        call.path.endsWith("/attempts") && call.options?.method === "POST"
    )
    expect(JSON.parse(String(prepare?.options?.body))).toMatchObject({
      assistantId: "assistant-a",
      source: "saved",
      baseRevision: 3,
      sampleRevision: 0,
      samples: rileyPracticeTemplate().samples,
      scenario: {
        transport: "success",
        overrides: { get_property_information: "unavailable" },
      },
    })
    expect(container!.textContent).toContain("Ready to call")
    // Prepared: Start replaces Prepare in the primary slot rather than sitting
    // beside it disabled.
    expect(absent("Prepare without calling")).toBe(true)
    expect(button("Start prepared call")).toBeDefined()
    // The other half of the gate: the attempt reports `execution: "disabled"`,
    // so now — and only now — the panel says so.
    expect(container!.textContent).toContain(
      "Voice calls are not available yet"
    )
    expect(container!.textContent).toContain("Preparation starts no agent")
    expect(
      container!.querySelector<HTMLFieldSetElement>("fieldset")?.disabled
    ).toBe(true)
    expect(container!.querySelector('a[href="/calls/call-a"]')).not.toBeNull()
    await click(button("Cancel preparation"))
    // Canceling releases the attempt's resources, so the panel lands in
    // `finished` rather than back at `idle` — and the headline says which of
    // the three routes into `finished` this was, instead of reporting that
    // resources were released.
    expect(container!.textContent).toContain("Preparation canceled")
    // Re-preparing is still offered, under the label that fits having just
    // finished one.
    expect(button("Prepare without calling").disabled).toBe(false)
    expect(button("Start another call").disabled).toBe(false)
    expect(
      calls.some((call) => /\/(start|join|presence)$/.test(call.path))
    ).toBe(false)
  })
  it("blocks preparation for compiler issues with a repair link", async () => {
    const calls = stubFetch()
    await render(initial, [
      { field: "samples", message: "Tool changed; review its sample mapping." },
    ])
    expect(container!.textContent).toContain(
      "Tool changed; review its sample mapping."
    )
    expect(button("Prepare without calling").disabled).toBe(true)
    expect(
      container!.querySelector('a[href="/assistants/assistant-a"]')
    ).not.toBeNull()
    expect(calls.every((call) => call.options?.method === "GET")).toBe(true)
  })
  it("reports local microphone denial without preparing a test", async () => {
    const calls = stubFetch()
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => {
          throw new DOMException("Denied", "NotAllowedError")
        }),
      },
    })
    await render()
    await click(button("Check microphone"))
    expect(container!.textContent).toContain("Microphone permission was denied")
    expect(calls.every((call) => call.options?.method === "GET")).toBe(true)
  })
  it("cleans up a pending microphone stream when the component leaves", async () => {
    stubFetch()
    let resolve!: (stream: MediaStream) => void
    const stop = vi.fn()
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(
          () =>
            new Promise<MediaStream>((done) => {
              resolve = done
            })
        ),
      },
    })
    await render()
    await click(button("Check microphone"))
    act(() => root!.unmount())
    root = undefined
    await act(async () => {
      resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream)
    })
    expect(stop).toHaveBeenCalledOnce()
  })
})
