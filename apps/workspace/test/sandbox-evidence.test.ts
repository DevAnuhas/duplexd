import { eq } from "drizzle-orm"
import { afterAll, describe, expect, it, vi } from "vitest"
import { GET as pollRoute } from "@/app/api/workspace/sandbox/calls/[id]/events/route"
import { requireWorkspaceSession } from "@/lib/workspace-mutation"
import { POST as eventRoute } from "@/app/v1/agent/calls/[id]/events/route"
import { POST as completeRoute } from "@/app/v1/agent/calls/[id]/complete/route"
import { GET as protocolRoute } from "@/app/v1/agent/calls/[id]/protocol/route"
import { getWorkspaceCallForAccount } from "@/data/calls"
import { closeDb, getDb } from "@/db/client"
import {
  callEvents,
  calls,
  sandboxAttempts,
  sandboxEvidence,
} from "@/db/schema"
import {
  getSandboxEventPage,
  parseSandboxEvents,
  parseSandboxCompletion,
} from "@/sandbox/evidence"
import type { SandboxCompletion, SandboxEvent } from "@/sandbox/protocol"
import { sandboxFixture } from "./helpers/sandbox.ts"
import { isDatabaseConfigured } from "./helpers/environment.ts"

vi.mock("@/lib/workspace-mutation", async (original) => ({
  ...(await original<typeof import("@/lib/workspace-mutation")>()),
  requireWorkspaceSession: vi.fn(),
}))

const completion: SandboxCompletion = {
  endedReason: "client_disconnected",
  durationSecs: 2.5,
  finalSeq: 2,
  producerLoss: false,
  truncated: false,
}
function event(
  seq: number,
  type = "interruption",
  payload: Record<string, unknown> = {}
): SandboxEvent {
  return { seq, at: "2026-09-22T00:00:00.000Z", type, payload }
}
function request(
  f: Awaited<ReturnType<typeof sandboxFixture>>,
  body: unknown,
  protocol: string | null = "sandbox-v1"
) {
  const headers = new Headers({
    authorization: `Bearer ${f.agent.token}`,
    "content-type": "application/json",
    "x-duplexd-session-id": f.owner.sessionId,
    "x-duplexd-boot-id": f.owner.bootId,
  })
  if (protocol) headers.set("x-duplexd-protocol", protocol)
  return new Request(
    `http://localhost/v1/agent/calls/${f.agent.callId}/events`,
    { method: "POST", headers, body: JSON.stringify(body) }
  )
}
afterAll(closeDb)

describe("frozen evidence schema", () => {
  it.each([
    { events: [event(0)] },
    { events: [event(10001)] },
    { events: [event(1), event(1)] },
    { events: [event(1, "agent_ready", { invented: true })] },
    { events: [event(1, "unknown")] },
    { events: [], legacy: true },
    { events: [event(1, "transcript_user", { text: "é".repeat(4096) })] },
    { events: Array.from({ length: 65 }, (_, i) => event(i + 1)) },
  ])("rejects invalid/oversize event envelope %#", (body) => {
    expect(parseSandboxEvents(body)).toBeNull()
  })
  it.each([
    { ...completion, finalSeq: -1 },
    { ...completion, finalSeq: 10001 },
    { ...completion, producerLoss: "false" },
    { ...completion, durationSecs: Infinity },
    { ...completion, durationSecs: -1 },
    { ...completion, extra: true },
  ])("rejects invalid completion %#", (body) => {
    expect(parseSandboxCompletion(body)).toBeNull()
  })
})

const describeDatabase = describe.skipIf(!isDatabaseConfigured())
describeDatabase("offline Sandbox evidence ledger", () => {
  it("marks a lost final batch partial and cannot revive a completed call when authenticated readiness arrives late", async () => {
    const f = await sandboxFixture()
    const params = { params: Promise.resolve({ id: f.agent.callId }) }

    // The agent has sent sequence 1, but its last event batch (sequence 2)
    // does not reach the server before its authenticated completion seal.
    const first = await eventRoute(request(f, { events: [event(1)] }), params)
    expect(first.status).toBe(200)
    const sealed = await completeRoute(
      request(f, { ...completion, finalSeq: 2 }),
      params
    )
    expect(sealed.status).toBe(200)
    expect(await sealed.json()).toMatchObject({
      evidenceState: "partial",
      missingRanges: [[2, 2]],
    })
    expect((await f.rows()).call.state).toBe("ended")
    expect(
      (await getWorkspaceCallForAccount(f.account.accountId, f.agent.callId))
        ?.call
    ).toMatchObject({ state: "ended", evidence: { state: "partial" } })

    // A replay can fill the evidence gap, but a historical agent_ready is
    // evidence about the past, never permission to activate the call again.
    const replay = await eventRoute(
      request(f, { events: [event(2, "agent_ready")] }),
      params
    )
    expect(replay.status).toBe(200)
    expect(await replay.json()).toMatchObject({ evidenceState: "complete" })
    const rows = await f.rows()
    expect(rows.attempt.readyAt).toBeNull()
    expect(rows.attempt.state).not.toBe("active")
    expect(rows.call.state).toBe("ended")
    expect(rows.ledger).toMatchObject({
      finalSeq: 2,
      contiguousSeq: 2,
      reconciled: true,
    })
    expect(
      (await getWorkspaceCallForAccount(f.account.accountId, f.agent.callId))
        ?.call.evidence?.state
    ).toBe("complete")
  })

  it("treats authenticated readiness as history when a terminal call has no stop request", async () => {
    const f = await sandboxFixture()
    const params = { params: Promise.resolve({ id: f.agent.callId }) }

    // Model a terminal state written by another recovery observer before a
    // stop request reached this attempt. The call state must still be enough
    // to prevent a late event from turning the attempt active.
    await getDb()
      .update(calls)
      .set({ state: "incomplete" })
      .where(eq(calls.id, f.agent.callId))
    await getDb()
      .update(sandboxAttempts)
      .set({ reportingUntil: new Date(Date.now() + 60_000) })
      .where(eq(sandboxAttempts.id, f.browser.attemptId))
    expect((await f.rows()).attempt.stopRequestedAt).toBeNull()

    const replay = await eventRoute(
      request(f, { events: [event(1, "agent_ready")] }),
      params
    )
    expect(replay.status).toBe(200)
    expect((await f.rows()).attempt.readyAt).toBeNull()
    expect((await f.rows()).attempt.state).not.toBe("active")
    expect((await f.rows()).call.state).toBe("incomplete")
  })

  it("accepts canonical replay once, trims ACK at gaps and reconciles a sealed missing sequence", async () => {
    const f = await sandboxFixture()
    expect(await f.evidence.ingest(f.agent, [event(2)])).toMatchObject({
      kind: "ok",
      ack: {
        contiguousSeq: 0,
        missingRanges: [[1, 1]],
        evidenceState: "unknown",
        completionDigest: null,
      },
    })
    expect(await f.evidence.complete(f.agent, completion)).toMatchObject({
      kind: "ok",
      ack: { evidenceState: "partial" },
    })
    const before = (await f.rows()).ledger!
    expect(
      await f.evidence.ingest(f.agent, [
        { payload: {}, type: "interruption", at: event(2).at, seq: 2 },
      ])
    ).toMatchObject({ kind: "ok" })
    expect((await f.rows()).ledger).toMatchObject({
      totalEvents: 1,
      totalBytes: before.totalBytes,
      lastCursor: before.lastCursor,
    })
    expect(
      await f.evidence.ingest(f.agent, [event(1, "agent_ready")])
    ).toMatchObject({
      kind: "ok",
      ack: {
        contiguousSeq: 2,
        missingRanges: [],
        evidenceState: "complete",
        completionDigest: before.completionDigest,
      },
    })
    const rows = await f.rows()
    expect(rows.ledger?.reconciled).toBe(true)
    expect(rows.attempt.readyAt).toBeNull()
    expect(rows.attempt.state).not.toBe("active")
    expect(rows.call.state).toBe("ended")
  })

  it.each(["content", "watermark", "completion"])(
    "persists %s conflict without replacing original content or seal",
    async (mode) => {
      const f = await sandboxFixture()
      await f.evidence.ingest(f.agent, [event(1), event(2)])
      await f.evidence.complete(f.agent, completion)
      const original = (await f.rows()).ledger!
      const result =
        mode === "completion"
          ? await f.evidence.complete(f.agent, {
              ...completion,
              durationSecs: 3,
            })
          : await f.evidence.ingest(f.agent, [
              mode === "watermark"
                ? event(3)
                : event(1, "transcript_user", { text: "changed" }),
            ])
      expect(result).toEqual({ kind: "integrity_conflict" })
      expect((await f.rows()).ledger).toMatchObject({
        integrityConflict: true,
        completionDigest: original.completionDigest,
        finalSeq: 2,
        totalEvents: 2,
      })
      expect(await f.evidence.complete(f.agent, completion)).toMatchObject({
        kind: "ok",
        ack: { evidenceState: "partial" },
      })
    }
  )

  it.each(["producerLoss", "truncated"] as const)(
    "never calls sealed evidence complete with %s",
    async (flag) => {
      const f = await sandboxFixture()
      expect(
        await f.evidence.complete(f.agent, {
          ...completion,
          finalSeq: 0,
          [flag]: true,
        })
      ).toMatchObject({
        kind: "ok",
        ack: { evidenceState: "partial", contiguousSeq: 0 },
      })
    }
  )

  it("keeps the exact completion digest on replay and enforces the original 60 second reporting deadline", async () => {
    const f = await sandboxFixture()
    const first = await f.evidence.complete(f.agent, completion)
    if (first.kind !== "ok") throw new Error(first.kind)
    const deadline = (await f.rows()).attempt.reportingUntil
    f.at(59999)
    expect(await f.evidence.complete(f.agent, completion)).toMatchObject({
      kind: "ok",
      ack: { completionDigest: first.ack.completionDigest },
    })
    expect(
      await f.evidence.ingest(f.agent, [event(1, "agent_ready")])
    ).toMatchObject({ kind: "ok" })
    expect((await f.rows()).attempt.reportingUntil).toEqual(deadline)
    f.at(60000)
    expect(await f.evidence.ingest(f.agent, [event(2)])).toEqual({
      kind: "expired",
    })
    expect(await f.evidence.complete(f.agent, completion)).toEqual({
      kind: "expired",
    })
  })

  it("records forced incomplete until observed completion and preserves separate platform namespace", async () => {
    const f = await sandboxFixture()
    await f.evidence.ingest(f.agent, [event(1)])
    f.at(60000)
    await f.lifecycle.control(f.agent)
    f.at(70000)
    await f.lifecycle.control(f.agent)
    expect((await f.rows()).call.state).toBe("incomplete")
    const result = await f.evidence.complete(f.agent, {
      ...completion,
      finalSeq: 1,
    })
    expect(result).toMatchObject({
      kind: "ok",
      ack: { contiguousSeq: 1, evidenceState: "complete" },
    })
    expect((await f.rows()).ledger?.reconciled).toBe(true)
    const page = await getSandboxEventPage(
      f.account.accountId,
      f.agent.callId,
      null
    )
    expect(page).toMatchObject({
      events: [
        expect.objectContaining({ namespace: "agent", seq: 1 }),
        expect.objectContaining({
          namespace: "platform",
          type: "completion_reconciled",
        }),
      ],
    })
    expect((await f.rows()).call).toMatchObject({
      state: "ended",
      endedReason: "client_disconnected",
      durationSecs: 2.5,
    })
  })

  it("natural completion retains capacity until independent exact terminal readback", async () => {
    const f = await sandboxFixture()
    await f.evidence.complete(f.agent, { ...completion, finalSeq: 0 })
    const rows = await f.rows()
    expect(rows.call.state).toBe("ended")
    expect(rows.attempt.stopRequestedAt).not.toBeNull()
    expect(rows.slots).toHaveLength(1)
    expect(rows.attempt.resourceState).not.toBe("confirmed_stopped")
    f.transport.read.mockResolvedValue({
      kind: "session",
      sessionId: f.owner.sessionId,
      binding: f.binding,
      state: "stopped",
    })
    await f.lifecycle.reconcile(f.browser.attemptId)
    expect((await f.rows()).slots).toHaveLength(0)
    expect((await f.rows()).attempt.resourceState).toBe("confirmed_stopped")
  })

  it("rejects wrong token, boot and session before creating evidence", async () => {
    const f = await sandboxFixture()
    for (const agent of [
      { ...f.agent, token: "wrong-token" },
      { ...f.agent, owner: { ...f.owner, bootId: "wrong-boot" } },
      { ...f.agent, owner: { ...f.owner, sessionId: "wrong-session" } },
    ]) {
      expect(await f.evidence.ingest(agent, [event(1)])).toEqual({
        kind: "not_found",
      })
      expect(await f.evidence.complete(agent, completion)).toEqual({
        kind: "not_found",
      })
    }
    expect((await f.rows()).ledger).toBeUndefined()
  })

  it("late producer 7 remains visible after cursor for 8, and polling allowlists payloads", async () => {
    const f = await sandboxFixture()
    await f.evidence.ingest(f.agent, [
      event(8, "tool_finished", {
        tool: "synthetic",
        invocationId: "i8",
        outcome: "success",
        durationMs: 10,
        arguments: { secret: "private-args" },
        result: "private-result",
        serverSecret: "private-secret",
        reasoning: "private-thoughts",
      }),
    ])
    const first = await getSandboxEventPage(
      f.account.accountId,
      f.agent.callId,
      null
    )
    if (!first || first === "invalid_cursor") throw new Error("missing page")
    expect(first.events.map((e) => e.seq)).toEqual([8])
    expect(JSON.stringify(first)).not.toMatch(
      /private-|arguments|serverSecret|reasoning/
    )
    await f.evidence.ingest(f.agent, [
      event(7, "transcript_user", { text: "synthetic spoken text" }),
    ])
    const next = await getSandboxEventPage(
      f.account.accountId,
      f.agent.callId,
      first.nextCursor
    )
    expect(next).toMatchObject({
      events: [
        expect.objectContaining({
          seq: 7,
          payload: { text: "synthetic spoken text" },
        }),
      ],
    })
    expect(
      await getSandboxEventPage(
        "wrong-account",
        f.agent.callId,
        first.nextCursor
      )
    ).toBeNull()
    expect(
      await getSandboxEventPage(
        f.account.accountId,
        f.agent.callId,
        first.nextCursor + "x"
      )
    ).toBe("invalid_cursor")
    const other = await sandboxFixture()
    expect(
      await getSandboxEventPage(
        other.account.accountId,
        other.agent.callId,
        first.nextCursor
      )
    ).toBe("invalid_cursor")
  })

  it("caps missing ranges at 32 and pages at 100 events", async () => {
    const f = await sandboxFixture()
    const result = await f.evidence.ingest(
      f.agent,
      Array.from({ length: 40 }, (_, i) => event(2 * (i + 1)))
    )
    expect(result).toMatchObject({
      kind: "ok",
      ack: {
        missingRanges: Array.from({ length: 32 }, (_, i) => [
          2 * i + 1,
          2 * i + 1,
        ]),
      },
    })
    await f.evidence.ingest(
      f.agent,
      Array.from({ length: 40 }, (_, i) => event(2 * i + 1))
    )
    await f.evidence.ingest(
      f.agent,
      Array.from({ length: 30 }, (_, i) => event(i + 81))
    )
    const first = await getSandboxEventPage(
      f.account.accountId,
      f.agent.callId,
      null
    )
    if (!first || first === "invalid_cursor") throw new Error("missing page")
    expect(first.events).toHaveLength(100)
    expect(first.hasMore).toBe(true)
    expect(
      await getSandboxEventPage(
        f.account.accountId,
        f.agent.callId,
        first.nextCursor
      )
    ).toMatchObject({ events: expect.any(Array), hasMore: false })
  })

  it("rate limits malformed and empty requests independently of valid replay and control", async () => {
    const f = await sandboxFixture()
    for (let i = 0; i < 10; i++)
      expect(await f.evidence.invalid(f.agent)).toEqual({
        kind: "invalid_request",
      })
    expect(await f.evidence.invalid(f.agent)).toEqual({ kind: "rate_limited" })
    expect(await f.evidence.ingest(f.agent, [])).toMatchObject({ kind: "ok" })
    expect(await f.evidence.ingest(f.agent, [])).toEqual({
      kind: "rate_limited",
    })
    expect(await f.evidence.ingest(f.agent, [event(1)])).toMatchObject({
      kind: "ok",
    })
    expect(await f.evidence.ingest(f.agent, [event(1)])).toMatchObject({
      kind: "ok",
    })
    expect(await f.lifecycle.control(f.agent)).toMatchObject({ kind: "ok" })
  })

  it("enforces total stored call bytes without charging identical retransmissions", async () => {
    const f = await sandboxFixture()
    await f.evidence.ingest(f.agent, [event(1)])
    await getDb()
      .update(sandboxEvidence)
      .set({ totalBytes: 8388608 })
      .where(eq(sandboxEvidence.callId, f.agent.callId))
    expect(await f.evidence.ingest(f.agent, [event(1)])).toMatchObject({
      kind: "ok",
    })
    expect(await f.evidence.ingest(f.agent, [event(2)])).toEqual({
      kind: "evidence_limit",
    })
    expect((await f.rows()).ledger?.producerLoss).toBe(true)
    expect(
      await getDb()
        .select()
        .from(callEvents)
        .where(eq(callEvents.callId, f.agent.callId))
    ).toHaveLength(1)
  })

  it("negotiates without reclaiming config and requires explicit version on both evidence routes", async () => {
    const f = await sandboxFixture()
    const params = { params: Promise.resolve({ id: f.agent.callId }) }
    const negotiated = await protocolRoute(
      new Request("http://localhost/protocol", {
        headers: { authorization: `Bearer ${f.agent.token}` },
      }),
      params
    )
    expect(await negotiated.json()).toEqual({ protocol: "sandbox-v1" })
    expect(
      await f.lifecycle.claim(f.agent, "http://localhost:3000")
    ).not.toMatchObject({ kind: "ok" })
    for (const route of [eventRoute, completeRoute]) {
      for (const header of [null, "sandbox-v2"]) {
        const response = await route(request(f, { events: [] }, header), params)
        expect(response.status).toBeGreaterThanOrEqual(400)
      }
    }
    expect((await f.rows()).ledger).toBeUndefined()
    expect(
      (await eventRoute(request(f, { events: [event(1)] }), params)).status
    ).toBe(200)
    const ended = await completeRoute(
      request(f, { ...completion, finalSeq: 1 }),
      params
    )
    expect(ended.status).toBe(200)
    expect(await ended.json()).toMatchObject({
      protocol: "sandbox-v1",
      evidenceState: "complete",
    })
  })
  it("authenticates account-scoped HTTP polling and keeps cursors non-authoritative", async () => {
    const f = await sandboxFixture()
    const params = { params: Promise.resolve({ id: f.agent.callId }) }
    const req = new Request(
      `http://localhost/api/workspace/sandbox/calls/${f.agent.callId}/events`
    )
    vi.mocked(requireWorkspaceSession).mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 401 }),
    })
    expect((await pollRoute(req, params)).status).toBe(401)
    vi.mocked(requireWorkspaceSession).mockResolvedValue({
      ok: true,
      account: {
        accountId: f.account.accountId,
        userId: f.account.userId,
        sessionId: "synthetic-session",
      },
    })
    const response = await pollRoute(req, params)
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toContain("no-store")
    vi.mocked(requireWorkspaceSession).mockResolvedValue({
      ok: true,
      account: {
        accountId: "different-account",
        userId: f.account.userId,
        sessionId: "synthetic-session",
      },
    })
    expect((await pollRoute(req, params)).status).toBe(404)
  })

  it("bounds HTTP batches by bytes and count while malformed floods leave valid replay usable", async () => {
    const f = await sandboxFixture()
    const params = { params: Promise.resolve({ id: f.agent.callId }) }
    const large = Array.from({ length: 40 }, (_, i) =>
      event(i + 1, "transcript_user", { text: "x".repeat(7800) })
    )
    expect(parseSandboxEvents({ events: large })).toBeNull()
    expect(
      (await eventRoute(request(f, { events: large }), params)).status
    ).toBe(413)
    for (let i = 1; i < 10; i++) {
      expect(
        (await eventRoute(request(f, { events: [event(0)] }), params)).status
      ).toBe(400)
    }
    expect(
      (await eventRoute(request(f, { events: [event(0)] }), params)).status
    ).toBe(429)
    expect(
      (await eventRoute(request(f, { events: [event(1)] }), params)).status
    ).toBe(200)
    expect(
      (await eventRoute(request(f, { events: [event(1)] }), params)).status
    ).toBe(200)
  })

  it("bounds projected pages by 128KiB even before reaching 100 rows", async () => {
    const f = await sandboxFixture()
    for (const offset of [0, 32]) {
      await f.evidence.ingest(
        f.agent,
        Array.from({ length: 32 }, (_, i) =>
          event(offset + i + 1, "transcript_user", { text: "é".repeat(3800) })
        )
      )
    }
    const page = await getSandboxEventPage(
      f.account.accountId,
      f.agent.callId,
      null
    )
    if (!page || page === "invalid_cursor") throw new Error("missing page")
    expect(page.events.length).toBeGreaterThan(0)
    expect(page.events.length).toBeLessThan(64)
    expect(page.hasMore).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
      128 * 1024
    )
  })
})
