import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, it, vi } from "vitest"

const fixture = vi.hoisted(() => ({
  call: null as null | {
    call: Record<string, unknown>
    reviewEvents: unknown[]
  },
  read: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("not found")
  },
}))
vi.mock("@/app/(app)/shell-data", () => ({
  requireShell: async () => ({
    account: { id: "account-one" },
    userId: "user-one",
  }),
}))
vi.mock("@/data/assistants", () => ({
  getAssistantForAccount: async () => ({
    name: "Synthetic assistant",
    revision: 1,
    voice: "alloy",
    backendModel: "gpt-5.6-luna",
  }),
}))
vi.mock("@/data/calls", () => ({
  getWorkspaceCallForAccount: async (accountId: string, callId: string) => {
    fixture.read(accountId, callId)
    return fixture.call
  },
}))
vi.mock("@/data/observations", () => ({
  getCallObservationsForAccount: async () => [],
}))
vi.mock("@/components/calls/call-review", () => ({
  CallReview: () => createElement("div", null, "Historical review"),
}))
vi.mock("@/app/(app)/assistants/[id]/sandbox/sandbox", () => ({
  Sandbox: (props: {
    initialScenario?: string
    retestFromHistory?: boolean
    retestFromPreview?: boolean
  }) =>
    createElement(
      "div",
      null,
      `Practice: ${props.initialScenario ?? "default"}; retest=${String(props.retestFromHistory)}; preview=${String(props.retestFromPreview)}`
    ),
}))

import SandboxPage from "@/app/(app)/assistants/[id]/sandbox/page"

function page(query: Record<string, string | string[]>) {
  return SandboxPage({
    params: Promise.resolve({ id: "assistant-one" }),
    searchParams: Promise.resolve(query),
  })
}

it("shows only the durable review for an account-scoped matching Sandbox call", async () => {
  fixture.read.mockClear()
  fixture.call = {
    call: {
      id: "call-one",
      source: "sandbox",
      assistantId: "assistant-one",
      configSource: "saved",
    },
    reviewEvents: [],
  }
  const html = renderToStaticMarkup(await page({ review: "call-one" }))
  expect(fixture.read).toHaveBeenCalledWith("account-one", "call-one")
  expect(html).toContain("Historical review")
  expect(html).not.toContain("Practice:")
})

it("falls back to Practice without showing another assistant's review", async () => {
  fixture.call = {
    call: {
      id: "call-one",
      source: "sandbox",
      assistantId: "assistant-two",
      configSource: "saved",
    },
    reviewEvents: [],
  }
  const html = renderToStaticMarkup(await page({ review: "call-one" }))
  expect(html).toContain("Practice: default")
  expect(html).not.toContain("Historical review")
})

it("opens a retest with a projected scenario and preview warning, without the old review", async () => {
  fixture.call = {
    call: {
      id: "call-one",
      source: "sandbox",
      assistantId: "assistant-one",
      configSource: "preview",
    },
    reviewEvents: [],
  }
  const html = renderToStaticMarkup(
    await page({ retest: "call-one", scenario: "slow" })
  )
  expect(html).toContain("Practice: slow; retest=true; preview=true")
  expect(html).not.toContain("Historical review")
})
