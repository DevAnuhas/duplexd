import { afterEach, describe, expect, it, vi } from "vitest"
import { SandboxController, sandboxReleased } from "@/sandbox/client/controller"
import type { SandboxBrowserAttempt } from "@/sandbox/browser-contract"
import type { SandboxMediaEvent } from "@/sandbox/client/media"

const input = {
  assistantId: "a",
  baseRevision: 1,
  source: "saved" as const,
  sampleRevision: 0,
  scenario: { transport: "success" as const, overrides: {} },
}
const base = Date.parse("2026-09-22T12:00:00Z")
const iso = (offset = 0) => new Date(base + offset).toISOString()
function attempt(
  patch: Partial<SandboxBrowserAttempt> = {}
): SandboxBrowserAttempt {
  return {
    attemptId: "attempt",
    callId: "call",
    assistantId: "a",
    source: "sandbox",
    testMode: "practice",
    state: "prepared",
    callState: "reserved",
    configSource: "saved",
    baseAssistantRevision: 1,
    preparedAt: iso(),
    reservationExpiresAt: iso(30_000),
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
    ...patch,
  }
}
function harness() {
  let now = 0
  let current: SandboxBrowserAttempt | null = null
  let ready = false
  let startFails = false
  let presenceFails = false
  let joinPending: (() => void) | null = null
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const path = String(url)
    requests.push({ url: path, init })
    if (path.endsWith("/csrf")) return Response.json({ token: "csrf" })
    if (path.endsWith("/start")) {
      if (startFails) throw new Error("lost")
      current = attempt({
        state: "starting",
        resourceState: "known_running",
        startupDeadline: iso(120_000),
        executionDeadline: iso(600_000),
        presenceExpiresAt: iso(60_000),
      })
    } else if (path.endsWith("/join")) {
      if (joinPending)
        await new Promise<void>((resolve) => {
          joinPending = resolve
        })
      return Response.json({
        join: {
          sessionId: "same-session",
          dailyRoom: "https://synthetic.daily.co/same-room",
          dailyToken: "synthetic-token",
          expiresAt: iso(600_000),
        },
      })
    } else if (path.endsWith("/presence")) {
      if (presenceFails)
        return Response.json(
          { code: "workspace_session_required" },
          { status: 401 }
        )
      return Response.json({
        serverTime: iso(now),
        presenceExpiresAt: iso(now + 60_000),
      })
    } else if (path.endsWith("/stop"))
      current = {
        ...current!,
        state: "stopping",
        stopRequestedAt: iso(now),
        resourceState: "stop_requested",
      }
    else if (init?.method === "POST") current = attempt()
    else if (current)
      current = {
        ...current,
        serverTime: iso(now),
        ...(ready ? { readyAt: iso(100), state: "active" } : {}),
      }
    return Response.json({ attempt: current })
  })
  let report!: (event: SandboxMediaEvent) => void
  const media = {
    prepare: vi.fn(async () => {}),
    join: vi.fn(async () => {}),
    mute: vi.fn(),
    stop: vi.fn(),
  }
  const factory = vi.fn((callback: typeof report) => {
    report = callback
    return media
  })
  const controller = new SandboxController(fetcher, () => now)
  return {
    controller,
    requests,
    fetcher,
    media,
    factory,
    event: (event: SandboxMediaEvent) => report(event),
    setReady: () => {
      ready = true
    },
    failStart: () => {
      startFails = true
    },
    failPresence: () => {
      presenceFails = true
    },
    setCurrent: (a: SandboxBrowserAttempt) => {
      current = a
    },
    advance: async (ms: number) => {
      now += ms
      await vi.advanceTimersByTimeAsync(ms)
    },
  }
}
afterEach(() => {
  vi.useRealTimers()
})
describe("gesture-owned Sandbox media controller", () => {
  it("requires local audio before one dispatch, uses one proof, and waits for persisted readiness", async () => {
    vi.useFakeTimers()
    const h = harness()
    await h.controller.prepare(input)
    let allow!: () => void
    h.media.prepare.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          allow = resolve
        })
    )
    const start = h.controller.start(h.factory)
    await h.controller.start(h.factory)
    expect(h.requests.some((r) => r.url.endsWith("/start"))).toBe(false)
    allow()
    await start
    expect(h.factory).toHaveBeenCalledTimes(1)
    expect(h.media.join).toHaveBeenCalledTimes(1)
    expect(h.controller.getSnapshot().mediaPhase).toBe("waiting")
    const proofs = h.requests
      .filter((r) => /\/(attempts|start|join)$/.test(r.url))
      .map(
        (r) =>
          (r.init?.headers as Record<string, string>)[
            "x-duplexd-controller-proof"
          ]
      )
    expect(new Set(proofs).size).toBe(1)
    h.setReady()
    await h.controller.refresh()
    expect(h.controller.getSnapshot().mediaPhase).toBe("ready")
    expect(JSON.stringify(h.controller.getSnapshot())).not.toContain(
      "synthetic-token"
    )
    h.controller.mute()
    expect(h.media.mute).toHaveBeenCalledWith(true)
    const stop = h.controller.end()
    expect(h.media.stop).toHaveBeenCalledTimes(1)
    await stop
    expect(h.controller.getSnapshot().mediaPhase).toBe("finishing")
    expect(sandboxReleased(h.controller.getSnapshot().attempt!)).toBe(false)
    h.setCurrent(
      attempt({
        state: "failed",
        callState: "incomplete",
        resourceState: "confirmed_stopped",
      })
    )
    await h.controller.refresh()
    expect(h.controller.getSnapshot().mediaPhase).toBe("off")
  })
  it("never starts disabled or observed/refreshed attempts", async () => {
    const h = harness()
    h.setCurrent(attempt())
    await h.controller.refresh()
    await h.controller.start(h.factory)
    expect(h.factory).not.toHaveBeenCalled()
    h.setCurrent(attempt({ execution: "disabled" }))
    await h.controller.refresh()
    await h.controller.start(h.factory)
    expect(h.factory).not.toHaveBeenCalled()
  })
  it("cancels pending permission synchronously and ignores its late success", async () => {
    vi.useFakeTimers()
    const h = harness()
    await h.controller.prepare(input)
    let allow!: () => void
    h.media.prepare.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          allow = resolve
        })
    )
    const start = h.controller.start(h.factory)
    h.controller.leave()
    expect(h.media.stop).toHaveBeenCalledOnce()
    allow()
    await start
    expect(h.requests.filter((r) => r.url.endsWith("/start"))).toHaveLength(0)
    expect(h.media.join).not.toHaveBeenCalled()
  })
  it("stops on unknown dispatch without retrying start or joining", async () => {
    vi.useFakeTimers()
    const h = harness()
    await h.controller.prepare(input)
    h.failStart()
    await h.controller.start(h.factory)
    await h.controller.start(h.factory)
    await h.controller.refresh()
    expect(h.requests.filter((r) => r.url.endsWith("/start"))).toHaveLength(1)
    expect(h.media.join).not.toHaveBeenCalled()
    expect(h.media.stop).toHaveBeenCalledOnce()
    expect(h.controller.getSnapshot().mediaPhase).toBe("finishing")
  })
  it("bounds SDK same-room reconnect and never redials", async () => {
    vi.useFakeTimers()
    const h = harness()
    await h.controller.prepare(input)
    await h.controller.start(h.factory)
    h.setReady()
    await h.controller.refresh()
    h.event({ type: "interrupted" })
    expect(h.controller.getSnapshot().mediaPhase).toBe("reconnecting")
    await h.advance(20_000)
    expect(h.media.stop).toHaveBeenCalledOnce()
    expect(h.requests.filter((r) => r.url.endsWith("/start"))).toHaveLength(1)
    expect(h.media.join).toHaveBeenCalledOnce()
  })
  it("loses readiness and stops immediately when presence authorization fails", async () => {
    vi.useFakeTimers()
    const h = harness()
    await h.controller.prepare(input)
    await h.controller.start(h.factory)
    h.setReady()
    await h.controller.refresh()
    h.failPresence()
    await h.advance(15_000)
    expect(h.media.stop).toHaveBeenCalledOnce()
    expect(h.controller.getSnapshot().mediaPhase).toBe("finishing")
  })
  it("bounds pending audio readiness before any dispatch", async () => {
    vi.useFakeTimers()
    const h = harness()
    await h.controller.prepare(input)
    h.media.prepare.mockImplementationOnce(() => new Promise(() => {}))
    void h.controller.start(h.factory)
    await h.advance(20_000)
    expect(h.media.stop).toHaveBeenCalledOnce()
    expect(h.requests.some((r) => r.url.endsWith("/start"))).toBe(false)
  })
  it("does not release a terminal call with unconfirmed resources", () => {
    expect(
      sandboxReleased(
        attempt({
          state: "failed",
          callState: "ended",
          resourceState: "possible",
        })
      )
    ).toBe(false)
    expect(
      sandboxReleased(
        attempt({ state: "expired", resourceState: "not_dispatched" })
      )
    ).toBe(true)
  })
})
