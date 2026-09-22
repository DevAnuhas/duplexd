import { describe, expect, it, vi } from "vitest"

import { SandboxController } from "@/sandbox/client/controller"
import type { SandboxAttemptDto } from "@/sandbox/admission"

const input = {
  assistantId: "assistant-a",
  baseRevision: 1,
  source: "saved" as const,
  sampleRevision: 0,
  scenario: { transport: "success" as const, overrides: {} },
}
function attempt(
  overrides: Partial<SandboxAttemptDto> = {}
): SandboxAttemptDto {
  return {
    attemptId: "attempt-a",
    callId: "call-a",
    assistantId: "assistant-a",
    state: "prepared",
    callState: "reserved",
    source: "sandbox",
    testMode: "practice",
    configSource: "saved",
    baseAssistantRevision: 1,
    preparedAt: "2026-09-22T09:00:00Z",
    reservationExpiresAt: "2026-09-22T09:00:30Z",
    canceledAt: null,
    expiredAt: null,
    stopRequestedAt: null,
    execution: "disabled",
    ...overrides,
  }
}
function json(body: unknown, status = 200) {
  return Response.json(body, { status })
}
function fetcher() {
  return vi.fn<typeof fetch>()
}

describe("Sandbox preparation controller", () => {
  it("calls native fetch with the global receiver, not the controller", async () => {
    const original = globalThis.fetch
    globalThis.fetch = function (this: unknown) {
      if (this !== globalThis) throw new TypeError("Illegal invocation")
      return Promise.resolve(json({ attempt: null }))
    }
    try {
      const controller = new SandboxController()
      await controller.refresh()
      expect(controller.getSnapshot().phase).toBe("idle")
    } finally {
      globalThis.fetch = original
    }
  })
  it("only reads on refresh; never starts or joins voice", async () => {
    const fetch = fetcher().mockResolvedValue(json({ attempt: null }))
    const controller = new SandboxController(fetch)
    await controller.refresh()
    expect(controller.getSnapshot()).toMatchObject({
      phase: "idle",
      attempt: null,
    })
    expect(fetch.mock.calls.map((call) => call[0])).toEqual([
      "/api/workspace/sandbox/attempts/current",
    ])
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
    })
  })

  it("locks repeated prepare clicks synchronously before CSRF resolves", async () => {
    let resolve!: (response: Response) => void
    const fetch = fetcher()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((done) => {
            resolve = done
          })
      )
      .mockResolvedValueOnce(json({ attempt: attempt() }, 201))
    const controller = new SandboxController(fetch)
    const first = controller.prepare(input)
    await controller.prepare(input)
    expect(fetch).toHaveBeenCalledTimes(1)
    resolve(json({ token: "csrf" }))
    await first
    expect(fetch).toHaveBeenCalledTimes(2)
    const options = fetch.mock.calls[1]?.[1]
    expect(options?.headers).toMatchObject({
      "x-duplexd-csrf": "csrf",
      "x-duplexd-controller-proof":
        expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    })
    expect(JSON.parse(String(options?.body))).toMatchObject({
      ...input,
      clientAttemptId: expect.any(String),
    })
    expect(controller.getSnapshot().attempt?.callId).toBe("call-a")
  })

  it("reuses the exact frozen payload and tab proof after a lost response", async () => {
    const fetch = fetcher()
      .mockResolvedValueOnce(json({ token: "csrf" }))
      .mockRejectedValueOnce(new Error("connection lost"))
      .mockResolvedValueOnce(json({ attempt: attempt() }))
    const controller = new SandboxController(fetch)
    await controller.prepare(input)
    expect(controller.getSnapshot()).toMatchObject({
      phase: "unknown",
      canRetryPreparation: true,
    })
    await controller.prepare({ ...input, baseRevision: 99 })
    const first = fetch.mock.calls[1]?.[1]
    const retry = fetch.mock.calls[2]?.[1]
    expect(retry?.body).toBe(first?.body)
    expect(retry?.headers).toEqual(first?.headers)
    expect(controller.getSnapshot().phase).toBe("idle")
  })

  it("does not lose a new uncertain preparation to a prior canceled record", async () => {
    const fetch = fetcher()
      .mockResolvedValueOnce(json({ token: "csrf" }))
      .mockResolvedValueOnce(json({ attempt: attempt() }))
      .mockResolvedValueOnce(json({ attempt: attempt({ state: "canceled" }) }))
      .mockRejectedValueOnce(new Error("lost"))
      .mockResolvedValueOnce(json({ attempt: null }))
      .mockResolvedValueOnce(
        json({ attempt: attempt({ attemptId: "attempt-b" }) })
      )
    const controller = new SandboxController(fetch)
    await controller.prepare(input)
    await controller.cancel()
    await controller.prepare(input)
    expect(controller.getSnapshot().attempt).toBeNull()
    const frozen = fetch.mock.calls[3]?.[1]?.body
    await controller.refresh()
    expect(fetch.mock.calls[4]?.[0]).toBe(
      "/api/workspace/sandbox/attempts/current"
    )
    expect(controller.getSnapshot().canRetryPreparation).toBe(true)
    await controller.prepare(input)
    expect(fetch.mock.calls[5]?.[1]?.body).toBe(frozen)
  })

  it("observes another tab's current reservation without claiming it", async () => {
    const other = attempt({ assistantId: "assistant-b" })
    const fetch = fetcher().mockResolvedValueOnce(json({ attempt: other }))
    const controller = new SandboxController(fetch)
    await controller.refresh()
    await controller.prepare(input)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(controller.getSnapshot().attempt).toEqual(other)
  })

  it("keeps unresolved state when cancellation response is lost", async () => {
    const fetch = fetcher()
      .mockResolvedValueOnce(json({ attempt: attempt() }))
      .mockResolvedValueOnce(json({ token: "csrf" }))
      .mockRejectedValueOnce(new Error("lost cancellation"))
    const controller = new SandboxController(fetch)
    await controller.refresh()
    await controller.cancel()
    expect(controller.getSnapshot()).toMatchObject({
      phase: "error",
      attempt: { state: "prepared" },
    })
    await controller.prepare(input)
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it("preserves terminal history after server-confirmed expiry", async () => {
    const fetch = fetcher()
      .mockResolvedValueOnce(json({ attempt: attempt() }))
      .mockResolvedValueOnce(
        json({ attempt: attempt({ state: "expired", callState: "failed" }) })
      )
    const controller = new SandboxController(fetch)
    await controller.refresh()
    await controller.refresh()
    expect(fetch.mock.calls[1]?.[0]).toBe(
      "/api/workspace/sandbox/attempts/attempt-a"
    )
    expect(controller.getSnapshot().attempt).toMatchObject({
      callId: "call-a",
      state: "expired",
    })
  })

  it("gives session/conflict errors without exposing arbitrary server details", async () => {
    const fetch = fetcher()
      .mockResolvedValueOnce(json({ token: "csrf" }))
      .mockResolvedValueOnce(
        json({ code: "assistant_changed", detail: "secret-canary" }, 409)
      )
    const controller = new SandboxController(fetch)
    await controller.prepare(input)
    expect(controller.getSnapshot().message).toContain("changed in another tab")
    expect(JSON.stringify(controller.getSnapshot())).not.toContain(
      "secret-canary"
    )
    expect(controller.getSnapshot().canRetryPreparation).toBe(false)
  })

  it("does not mutate if the CSRF session request is rejected", async () => {
    const fetch = fetcher().mockResolvedValueOnce(
      json({ code: "workspace_session_required" }, 401)
    )
    const controller = new SandboxController(fetch)
    await controller.prepare(input)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(controller.getSnapshot().message).toContain("session expired")
  })

  it("rejects a malformed successful preparation as unknown, preserving retry identity", async () => {
    const fetch = fetcher()
      .mockResolvedValueOnce(json({ token: "csrf" }))
      .mockResolvedValueOnce(json({ attempt: { state: "active" } }))
      .mockResolvedValueOnce(json({ attempt: attempt() }))
    const controller = new SandboxController(fetch)
    await controller.prepare(input)
    expect(controller.getSnapshot().phase).toBe("unknown")
    await controller.prepare(input)
    expect(fetch.mock.calls[2]?.[1]?.body).toBe(fetch.mock.calls[1]?.[1]?.body)
  })
})
