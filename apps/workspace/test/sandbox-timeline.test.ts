import { describe, expect, it, vi } from "vitest"
import {
  readEventPage,
  SandboxTimelineController,
} from "@/sandbox/client/timeline"
import type { SandboxEventPage } from "@/sandbox/protocol"

type Event = SandboxEventPage["events"][number]
function event(seq: number, patch: Partial<Event> = {}): Event {
  return {
    cursor: `ingestion-${seq}`,
    namespace: "agent",
    seq,
    at: "2026-09-22T12:00:00Z",
    type: "transcript_user",
    payload: { text: `Synthetic transcript ${seq}` },
    ...patch,
  }
}
function page(
  events: Event[] = [],
  patch: Partial<SandboxEventPage> = {}
): SandboxEventPage {
  return {
    events,
    nextCursor: events.at(-1)?.cursor ?? null,
    hasMore: false,
    evidence: {
      state: "partial",
      contiguousSeq: 0,
      finalSeq: null,
      producerLoss: false,
      truncated: false,
      integrityConflict: false,
      reconciled: false,
    },
    ...patch,
  }
}
function harness() {
  const fetcher = vi.fn<typeof fetch>()
  const controller = new SandboxTimelineController("synthetic/call", fetcher)
  return { fetcher, controller }
}
function respond(h: ReturnType<typeof harness>, value: unknown) {
  h.fetcher.mockResolvedValueOnce(Response.json(value))
}

describe("bounded ingestion-cursor timeline", () => {
  it("loads at most three 100-event pages per refresh and resumes from the last opaque cursor", async () => {
    const h = harness()
    for (let p = 0; p < 4; p++)
      respond(
        h,
        page(
          Array.from({ length: 100 }, (_, i) => event(p * 100 + i)),
          { hasMore: p < 3, nextCursor: `opaque/${p}+?` }
        )
      )
    await h.controller.refresh()
    expect(h.fetcher).toHaveBeenCalledTimes(3)
    expect(h.controller.getSnapshot()).toMatchObject({
      events: expect.any(Array),
      hasMore: true,
      loading: false,
      error: null,
    })
    expect(h.controller.getSnapshot().events).toHaveLength(300)
    expect(h.fetcher.mock.calls[0]![0]).toBe(
      "/api/workspace/sandbox/calls/synthetic%2Fcall/events"
    )
    expect(h.fetcher.mock.calls[1]![0]).toContain("?after=opaque%2F0%2B%3F")
    expect(h.fetcher.mock.calls[0]![1]).toMatchObject({
      credentials: "same-origin",
      cache: "no-store",
      signal: expect.any(AbortSignal),
    })
    await h.controller.refresh()
    expect(h.fetcher).toHaveBeenCalledTimes(4)
    expect(h.fetcher.mock.calls[3]![0]).toContain("?after=opaque%2F2%2B%3F")
    expect(h.controller.getSnapshot().events).toHaveLength(400)
    expect(h.controller.getSnapshot().hasMore).toBe(false)
  })

  it("catches late sequence 7 after 8 using ingestion cursors and preserves producer order across clock regression", async () => {
    const h = harness()
    respond(
      h,
      page([event(8, { cursor: "arrival-a", at: "2026-09-22T12:00:01Z" })])
    )
    respond(
      h,
      page([event(7, { cursor: "arrival-b", at: "2026-09-22T12:00:09Z" })])
    )
    await h.controller.refresh()
    await h.controller.refresh()
    expect(h.fetcher.mock.calls[1]![0]).toContain("?after=arrival-a")
    expect(h.controller.getSnapshot().events.map((e) => e.seq)).toEqual([7, 8])
    respond(
      h,
      page([event(9, { cursor: "arrival-c", at: "2026-09-22T11:59:59Z" })])
    )
    await h.controller.refresh()
    expect(h.fetcher.mock.calls[2]![0]).toContain("?after=arrival-b")
    expect(h.controller.getSnapshot().events.map((e) => e.seq)).toEqual([
      7, 8, 9,
    ])
  })

  it("deduplicates namespace/sequence within and across pages without collapsing different producers", async () => {
    const h = harness()
    respond(
      h,
      page([
        event(1),
        event(1, { cursor: "repeat" }),
        event(1, {
          namespace: "platform",
          cursor: "platform-1",
          type: "stop_requested",
        }),
      ])
    )
    respond(h, page([event(1, { cursor: "replay" }), event(2)]))
    await h.controller.refresh()
    await h.controller.refresh()
    expect(
      h.controller
        .getSnapshot()
        .events.map((e) => `${e.namespace}:${e.seq}`)
        .sort()
    ).toEqual(["agent:1", "agent:2", "platform:1"])
  })

  it.each([401, 403, 500, "network", "malformed"])(
    "keeps history, evidence and cursor after %s then clears the error on recovery",
    async (failure) => {
      const h = harness()
      respond(h, page([event(1)]))
      await h.controller.refresh()
      const before = h.controller.getSnapshot()
      if (typeof failure === "number")
        h.fetcher.mockResolvedValueOnce(
          new Response("private backend diagnostic", { status: failure })
        )
      else if (failure === "network")
        h.fetcher.mockRejectedValueOnce(
          new Error("synthetic secret diagnostic")
        )
      else
        h.fetcher.mockResolvedValueOnce(
          new Response("not-json synthetic secret diagnostic")
        )
      await h.controller.refresh()
      const failed = h.controller.getSnapshot()
      expect(failed.events).toEqual(before.events)
      expect(failed.evidence).toEqual(before.evidence)
      expect(failed.updatedAt).toBe(before.updatedAt)
      expect(failed.loading).toBe(false)
      expect(failed.error).toContain(
        failure === 401 || failure === 403
          ? "Sign in again"
          : "Evidence updates are unavailable"
      )
      expect(JSON.stringify(failed)).not.toContain("diagnostic")
      respond(h, page([event(2)]))
      await h.controller.refresh()
      expect(h.fetcher.mock.calls[2]![0]).toContain("?after=ingestion-1")
      expect(h.controller.getSnapshot()).toMatchObject({
        error: null,
        loading: false,
      })
      expect(h.controller.getSnapshot().events).toHaveLength(2)
    }
  )

  it.each([null, "ingestion-1"])(
    "rejects non-advancing cursor %s without accepting its events",
    async (nextCursor) => {
      const h = harness()
      respond(h, page([event(1)]))
      await h.controller.refresh()
      respond(h, page([event(2)], { hasMore: true, nextCursor }))
      await h.controller.refresh()
      expect(h.controller.getSnapshot().events.map((e) => e.seq)).toEqual([1])
      expect(h.controller.getSnapshot().error).toContain("unavailable")
      expect(h.fetcher).toHaveBeenCalledTimes(2)
    }
  )

  it("rejects pages over 100 events while retaining prior events", async () => {
    const h = harness()
    respond(h, page([event(1)]))
    respond(h, page(Array.from({ length: 101 }, (_, i) => event(i + 2))))
    await h.controller.refresh()
    await h.controller.refresh()
    expect(h.controller.getSnapshot().events).toHaveLength(1)
    expect(h.controller.getSnapshot().error).toContain("unavailable")
  })

  it("enforces the 128 KiB response limit in UTF-8 bytes, not characters", async () => {
    const h = harness()
    const accepted = JSON.stringify(page([event(1)]))
    h.fetcher.mockResolvedValueOnce(
      new Response(
        accepted +
          " ".repeat(131072 - new TextEncoder().encode(accepted).length)
      )
    )
    await h.controller.refresh()
    expect(h.controller.getSnapshot().events).toHaveLength(1)
    const tooLarge = JSON.stringify(
      page([event(2, { payload: { text: "界".repeat(45000) } })])
    )
    expect(tooLarge.length).toBeLessThan(131072)
    expect(new TextEncoder().encode(tooLarge).length).toBeGreaterThan(131072)
    h.fetcher.mockResolvedValueOnce(new Response(tooLarge))
    await h.controller.refresh()
    expect(h.controller.getSnapshot().events).toHaveLength(1)
    expect(h.controller.getSnapshot().error).toContain("unavailable")
  })

  it.each(["events", "bytes"])(
    "stops permanently at the retained %s budget without dropping loaded evidence",
    async (budget) => {
      const h = harness()
      let seq = 0
      h.fetcher.mockImplementation(async () => {
        const events = Array.from(
          { length: budget === "events" ? 100 : 10 },
          () =>
            event(++seq, {
              payload: {
                text: budget === "events" ? "short" : "x".repeat(8000),
              },
            })
        )
        return Response.json(page(events, { hasMore: true }))
      })
      for (let i = 0; i < 15 && !h.controller.getSnapshot().limited; i++)
        await h.controller.refresh()
      const final = h.controller.getSnapshot()
      expect(final).toMatchObject({
        limited: true,
        hasMore: true,
        loading: false,
        error: null,
      })
      expect(final.events.length).toBeGreaterThan(0)
      expect(final.events.length).toBeLessThanOrEqual(2000)
      expect(
        new TextEncoder().encode(JSON.stringify(final.events)).length
      ).toBeLessThanOrEqual(2 * 1024 * 1024)
      if (budget === "events") expect(final.events).toHaveLength(2000)
      else expect(final.events.length).toBeLessThan(2000)
      const count = h.fetcher.mock.calls.length
      await h.controller.refresh()
      expect(h.fetcher).toHaveBeenCalledTimes(count)
      expect(h.controller.getSnapshot()).toBe(final)
    }
  )

  it("allows only one request in flight and ignores a paused late response, then resumes", async () => {
    const h = harness()
    let resolve!: (response: Response) => void
    h.fetcher.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      })
    )
    const first = h.controller.refresh()
    expect(h.controller.getSnapshot().loading).toBe(true)
    await h.controller.refresh()
    expect(h.fetcher).toHaveBeenCalledOnce()
    h.controller.pause()
    expect(h.fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(true)
    resolve(Response.json(page([event(1)])))
    await first
    expect(h.controller.getSnapshot()).toMatchObject({
      events: [],
      loading: false,
      error: null,
    })
    respond(h, page([event(2)]))
    await h.controller.refresh()
    expect(h.fetcher.mock.calls[1]![0]).not.toContain("?after=")
    expect(h.controller.getSnapshot().events.map((e) => e.seq)).toEqual([2])
  })

  it("unsubscribes listeners and prevents disposed late responses from publishing", async () => {
    const h = harness()
    const listener = vi.fn()
    const unsubscribe = h.controller.subscribe(listener)
    let resolve!: (response: Response) => void
    h.fetcher.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      })
    )
    const pending = h.controller.refresh()
    expect(listener).toHaveBeenCalledOnce()
    unsubscribe()
    h.controller.dispose()
    resolve(Response.json(page([event(1)])))
    await pending
    await h.controller.refresh()
    expect(h.controller.getSnapshot().events).toEqual([])
    expect(listener).toHaveBeenCalledOnce()
    expect(h.fetcher).toHaveBeenCalledOnce()
  })
})

describe("safe evidence projection", () => {
  it("keeps only bounded display fields and never retains raw arguments, results or envelope secrets", () => {
    const raw = {
      ...page([
        event(1, {
          payload: {
            text: "<img src=x onerror=alert(1)>\n" + "x".repeat(9000),
            secret: "SYNTHETIC_SECRET",
          },
        }),
        event(2, {
          type: "tool_finished",
          payload: {
            tool: "x".repeat(200),
            invocationId: "synthetic-invocation",
            outcome: "failure",
            durationMs: 80,
            status: 503,
            practiceScenario: "failure",
            practiceSelectedStatus: 200,
            arguments: "SYNTHETIC_SECRET",
            results: "SYNTHETIC_SECRET",
          },
        }),
        event(3, {
          type: "agent_ready",
          payload: { text: "SYNTHETIC_SECRET", token: "SYNTHETIC_SECRET" },
        }),
      ]),
      rawToken: "SYNTHETIC_SECRET",
    }
    const result = readEventPage(raw)
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC_SECRET")
    expect(result.events[0]!.payload!.text).toHaveLength(8000)
    expect(result.events[0]!.payload!.text).toContain(
      "<img src=x onerror=alert(1)>"
    )
    expect(result.events[1]!.payload).toEqual({
      tool: "x".repeat(160),
      invocationId: "synthetic-invocation",
      outcome: "failure",
      durationMs: 80,
      status: 503,
      practiceScenario: "failure",
      practiceSelectedStatus: 200,
    })
    expect(result.events[2]!.payload).toEqual({})
  })

  it.each([
    { namespace: "private" },
    { seq: -1 },
    { seq: 1.5 },
    { seq: Number.MAX_SAFE_INTEGER + 1 },
    { cursor: "x".repeat(257) },
    { at: "invalid" },
    { type: "x".repeat(101) },
    { payload: [] },
  ])("rejects malformed event %j", (patch) => {
    expect(() =>
      readEventPage({ ...page(), events: [{ ...event(1), ...patch }] })
    ).toThrow()
  })

  it.each([
    { state: "ended" },
    { contiguousSeq: -1 },
    { finalSeq: 1.5 },
    { producerLoss: "false" },
    { truncated: null },
    { integrityConflict: 1 },
    { reconciled: undefined },
  ])("rejects malformed evidence %j", (patch) => {
    const value = page()
    expect(() =>
      readEventPage({ ...value, evidence: { ...value.evidence, ...patch } })
    ).toThrow()
  })
})
