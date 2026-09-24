import "./helpers/assistant-form/dom-environment.ts"

import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

import { CallReview } from "@/components/calls/call-review"
import { ObservationEditor } from "@/components/calls/observation-editor"
import type { WorkspaceCall } from "@/data/calls"
import type { Observation } from "@/data/observations"

const callId = "synthetic-call"
const observation: Observation = {
  id: "synthetic-observation",
  revision: 1,
  checklistVersion: 1,
  heardExpectedAnswer: "met",
  correctToolOutcome: "not_checked",
  honestFailureSpeech: "not_checked",
  acceptableInterruptionWaiting: "not_checked",
  note: "Initial note",
  authorName: "Member",
  isMine: true,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
}

let root: Root | undefined
let host: HTMLDivElement | undefined

async function mount(rows: Observation[]) {
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      createElement(ObservationEditor, {
        callId,
        initialObservations: rows,
      })
    )
  })
}

function button(label: string): HTMLButtonElement {
  const found = [...host!.querySelectorAll("button")].find(
    (item) => item.textContent === label
  )
  if (!found) throw new Error(`Missing button: ${label}`)
  return found
}

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  vi.unstubAllGlobals()
})

it("requires an explicit conflict choice before saving edits against a newer revision", async () => {
  const requests: Array<{ path: string; body?: Record<string, unknown> }> = []
  const changed = { ...observation, revision: 2, note: "Other tab's note" }
  const saved = { ...changed, revision: 3, note: "Initial note" }
  let saves = 0
  vi.stubGlobal("fetch", async (path: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ path, body })
    if (path.endsWith("/csrf")) return Response.json({ token: "csrf" })
    saves += 1
    return saves === 1
      ? Response.json(
          { code: "observation_conflict", current: changed },
          { status: 409 }
        )
      : Response.json({ observation: saved })
  })

  await mount([observation])
  await act(async () => button("Save observations").click())

  expect(requests[1]?.body?.expectedRevision).toBe(1)
  expect(host!.textContent).toContain("This review changed in another tab")
  expect(button("Save observations").disabled).toBe(true)
  expect(host!.querySelector("textarea")?.value).toBe("Initial note")

  await act(async () => button("Keep my edits").click())
  expect(button("Save observations").disabled).toBe(false)
  await act(async () => button("Save observations").click())

  expect(requests[3]?.body?.expectedRevision).toBe(2)
  expect(requests[3]?.body?.note).toBe("Initial note")
  expect(host!.textContent).toContain("Your observations were saved")
})

it("renders another member's note as text and offers no control to edit it", async () => {
  const other = {
    ...observation,
    id: "other-observation",
    authorName: "Other member",
    isMine: false,
    note: "<img src=x onerror=alert(1)>",
  }
  await mount([other])

  expect(host!.textContent).toContain(other.note)
  expect(host!.querySelector("img")).toBeNull()
  expect(host!.querySelectorAll("textarea")).toHaveLength(1)
  expect(host!.textContent).toContain("Other members’ observations")
})

function historicalCall(startedAt: string | null): WorkspaceCall {
  return {
    id: callId,
    assistantId: "synthetic-assistant",
    apiKeyId: null,
    pipecatSessionId: null,
    dailyRoom: null,
    state: "failed",
    endedReason: startedAt === null ? "canceled_before_dispatch" : "agent_lost",
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt,
    endedAt: "2026-01-01T00:01:00.000Z",
    durationSecs: null,
    lastHeartbeatAt: null,
    source: "sandbox",
    testMode: "practice",
    assistantName: "Synthetic assistant",
    assistantArchived: false,
    configSource: "saved",
    baseAssistantRevision: 1,
    scenarioRevision: 0,
    scenario: "custom",
    scenarioHasOverrides: true,
    readyAt: null,
    reportingUntil: null,
    apiKey: null,
    evidence: {
      state: "unknown",
      contiguousSeq: 0,
      finalSeq: null,
      producerLoss: false,
      truncated: false,
      integrityConflict: false,
      reconciled: false,
    },
  }
}

it("does not invite a review of a preparation that never reached voice", () => {
  const html = renderToStaticMarkup(
    createElement(CallReview, {
      call: historicalCall(null),
      events: [],
      observations: [],
    })
  )
  expect(html).toContain("No voice execution")
  expect(html).not.toContain("Your observations")
  expect(html).not.toContain("The evidence record is")
})

it("opens Test again in Practice without the historical review or custom override", () => {
  const html = renderToStaticMarkup(
    createElement(CallReview, {
      call: historicalCall("2026-01-01T00:00:10.000Z"),
      events: [],
      observations: [],
    })
  )
  expect(html).toContain("Custom named sample overrides")
  expect(html).toContain(
    "/assistants/synthetic-assistant/sandbox?retest=synthetic-call"
  )
  expect(html).not.toContain("scenario=custom")
  expect(html).toContain("Your observations")
})
