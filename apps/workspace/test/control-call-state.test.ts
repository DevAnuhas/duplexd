import { randomUUID } from "node:crypto"

import { afterAll, describe, expect, it } from "vitest"

import { handleSweepRequest } from "@/app/v1/internal/sweep/route"
import {
  PLATFORM_CORRECTION_SEQUENCE,
  PLATFORM_SWEEP_SEQUENCE,
} from "@/control/constants"
import {
  completeAgentCall,
  getCallForAccount,
  ingestAgentEvents,
  listCallsForAccount,
  sweepStaleCalls,
  type AgentEventInput,
} from "@/data/calls"
import { closeDb, getDb } from "@/db/client"
import { calls } from "@/db/schema"
import { hashCredential } from "@/lib/credentials"
import { encryptSecret } from "@/lib/crypto"

import { withTestPool } from "./helpers/database.ts"
import { isDatabaseConfigured } from "./helpers/environment.ts"

const describeDatabase = describe.skipIf(!isDatabaseConfigured())

afterAll(async () => {
  await closeDb()
})

const SNAPSHOT = {
  assistantId: "state-machine-assistant",
  voice: "marin",
  instructions: "Synthetic state-machine test.",
  accentStyle: "",
  waitingBehavior: "",
  backendModel: "gpt-test-responses",
  backendInstructions: "Use synthetic data only.",
  serverUrl: "https://customer.example.invalid/tools",
  serverSecretCiphertext: encryptSecret("synthetic-state-machine-secret"),
  tools: [],
} as const

async function seedCall(input: {
  state: "starting" | "active" | "incomplete" | "ended" | "failed"
  createdAt?: Date
  startedAt?: Date | null
  lastHeartbeatAt?: Date | null
  durationSecs?: number | null
  endedReason?: string | null
  endedAt?: Date | null
}): Promise<{ accountId: string; callId: string; rawToken: string }> {
  const accountId = randomUUID()
  const callId = randomUUID()
  const rawToken = `state-token-${randomUUID()}`

  await withTestPool(async (pool) => {
    await pool.query("INSERT INTO accounts (id, name) VALUES ($1, $2)", [
      accountId,
      "call state test",
    ])
  })
  await getDb()
    .insert(calls)
    .values({
      id: callId,
      accountId,
      assistantSnapshot: SNAPSHOT,
      agentTokenHash: hashCredential(rawToken),
      state: input.state,
      createdAt: input.createdAt ?? new Date(),
      startedAt: input.startedAt ?? null,
      lastHeartbeatAt: input.lastHeartbeatAt ?? null,
      durationSecs: input.durationSecs ?? null,
      endedReason: input.endedReason ?? null,
      endedAt: input.endedAt ?? null,
    })

  return { accountId, callId, rawToken }
}

async function storedEvents(
  callId: string
): Promise<Array<{ seq: number; type: string; payload: unknown; at: string }>> {
  return withTestPool(async (pool) => {
    const { rows } = await pool.query<{
      seq: number
      type: string
      payload: unknown
      at: string
    }>(
      `SELECT seq,
              type,
              payload,
              to_char(
                at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
              ) AS at
       FROM call_events WHERE call_id = $1 ORDER BY seq`,
      [callId]
    )
    return rows
  })
}

async function storedCall(callId: string): Promise<{
  state: string
  ended_reason: string | null
  duration_secs: string | null
  ended_at: string | null
  last_heartbeat_at: string | null
}> {
  return withTestPool(async (pool) => {
    const { rows } = await pool.query<{
      state: string
      ended_reason: string | null
      duration_secs: string | null
      ended_at: string | null
      last_heartbeat_at: string | null
    }>(
      `SELECT state, ended_reason, duration_secs::text,
              ended_at::text, last_heartbeat_at::text
       FROM calls WHERE id = $1`,
      [callId]
    )
    expect(rows, "the call row disappeared").toHaveLength(1)
    return rows[0]!
  })
}

function event(seq: number, type = "transcript_user"): AgentEventInput {
  return {
    seq,
    at: `2026-09-20T10:00:0${Math.min(seq, 9)}.123456+00:00`,
    type,
    payload: { text: `payload-${seq}`, nested: { exact: true } },
  }
}

describeDatabase("event idempotency and overlap", () => {
  it("stores new suffix events from an overlapping retry without rewriting the overlap", async () => {
    const { callId, rawToken } = await seedCall({ state: "active" })
    const first = [event(1), event(2), event(3)]
    const overlap = {
      ...event(3),
      payload: { text: "must-not-replace-first-write" },
    }

    expect(await ingestAgentEvents(callId, rawToken, first)).toStrictEqual({
      kind: "ok",
    })
    const firstRowThree = (await storedEvents(callId)).find(
      (row) => row.seq === 3
    )

    expect(
      await ingestAgentEvents(callId, rawToken, [overlap, event(4), event(5)])
    ).toStrictEqual({ kind: "ok" })

    const rows = await storedEvents(callId)
    expect(rows.map((row) => row.seq)).toStrictEqual([1, 2, 3, 4, 5])
    expect(rows[2]?.at).toBe("2026-09-20T10:00:03.123456Z")
    expect(rows.find((row) => row.seq === 3)).toStrictEqual(firstRowThree)

    expect(await ingestAgentEvents(callId, rawToken, first)).toStrictEqual({
      kind: "ok",
    })
    expect(await storedEvents(callId)).toStrictEqual(rows)
  })

  it("accepts late observations after incomplete without changing the state", async () => {
    const { callId, rawToken } = await seedCall({
      state: "incomplete",
      endedReason: "agent_lost",
      endedAt: new Date("2026-09-20T10:03:00Z"),
    })

    expect(await ingestAgentEvents(callId, rawToken, [event(1)])).toStrictEqual(
      { kind: "ok" }
    )
    expect(await storedEvents(callId)).toHaveLength(1)
    expect((await storedCall(callId)).state).toBe("incomplete")
  })
})

describeDatabase("honest completion", () => {
  it.each(["client_disconnected", "pipeline_error", "idle_timeout"] as const)(
    "accepts the real agent reason %s and stores fractional duration",
    async (endedReason) => {
      const { callId, rawToken } = await seedCall({ state: "active" })

      expect(
        await completeAgentCall(callId, rawToken, {
          endedReason,
          durationSecs: 12.345,
        })
      ).toStrictEqual({ kind: "ok" })

      const ended = await storedCall(callId)
      expect(ended.state).toBe("ended")
      expect(ended.ended_reason).toBe(endedReason)
      expect(ended.duration_secs).toBe("12.345")
      expect(ended.ended_at).not.toBeNull()
    }
  )

  it("expires the credential after normal completion without rewriting the first ending", async () => {
    const { callId, rawToken } = await seedCall({ state: "active" })
    expect(
      await completeAgentCall(callId, rawToken, {
        endedReason: "client_disconnected",
        durationSecs: 12.345,
      })
    ).toStrictEqual({ kind: "ok" })
    const firstEnding = await storedCall(callId)

    expect(
      await completeAgentCall(callId, rawToken, {
        endedReason: "pipeline_error",
        durationSecs: 99.999,
      })
    ).toStrictEqual({ kind: "expired_token" })
    expect(await storedCall(callId)).toStrictEqual(firstEnding)
    expect(await storedEvents(callId)).toHaveLength(0)
  })

  it("corrects incomplete to ended and keeps late observations", async () => {
    const { callId, rawToken } = await seedCall({
      state: "incomplete",
      endedReason: "agent_lost",
      endedAt: new Date("2026-09-20T10:03:00Z"),
    })
    await ingestAgentEvents(callId, rawToken, [event(7)])

    expect(
      await completeAgentCall(callId, rawToken, {
        endedReason: "idle_timeout",
        durationSecs: 12.345,
      })
    ).toStrictEqual({ kind: "ok" })

    const ended = await storedCall(callId)
    expect(ended.state).toBe("ended")
    expect(ended.ended_reason).toBe("idle_timeout")
    expect(ended.duration_secs).toBe("12.345")
    const rows = await storedEvents(callId)
    expect(rows.map((row) => row.seq)).toStrictEqual([
      7,
      PLATFORM_CORRECTION_SEQUENCE,
    ])
    expect(rows[0]?.payload).toStrictEqual(event(7).payload)
    expect(rows[1]).toMatchObject({
      seq: PLATFORM_CORRECTION_SEQUENCE,
      type: "ended",
      payload: {
        state: "ended",
        reason: "idle_timeout",
        correctedFrom: "incomplete",
      },
    })
  })
})

describeDatabase("stale call sweeps", () => {
  it("derives stale read states without persisting or appending a sweep event", async () => {
    const now = new Date()
    const stale = new Date(now.getTime() - 10 * 60_000)
    const staleActive = await seedCall({
      state: "active",
      createdAt: stale,
      startedAt: stale,
      lastHeartbeatAt: stale,
    })
    const staleStarting = await seedCall({
      state: "starting",
      createdAt: stale,
    })

    const detail = await getCallForAccount(
      staleActive.accountId,
      staleActive.callId
    )
    const list = await listCallsForAccount(staleActive.accountId)
    expect(detail?.call).toMatchObject({
      state: "incomplete",
      endedReason: "agent_lost",
      endedAt: null,
    })
    expect(list.kind).toBe("ok")
    if (list.kind === "ok") {
      expect(list.calls[0]).toMatchObject({
        state: "incomplete",
        endedReason: "agent_lost",
        endedAt: null,
      })
    }
    expect(
      (await getCallForAccount(staleStarting.accountId, staleStarting.callId))
        ?.call
    ).toMatchObject({
      state: "failed",
      endedReason: "agent_never_started",
      endedAt: null,
    })
    expect((await storedCall(staleActive.callId)).state).toBe("active")
    expect((await storedCall(staleStarting.callId)).state).toBe("starting")
    expect(
      (await storedEvents(staleActive.callId)).filter(
        (row) => row.seq === PLATFORM_SWEEP_SEQUENCE
      )
    ).toHaveLength(0)
    expect(
      (await storedEvents(staleStarting.callId)).filter(
        (row) => row.seq === PLATFORM_SWEEP_SEQUENCE
      )
    ).toHaveLength(0)
  })

  it("keeps fresh active and starting calls unchanged through the same reads", async () => {
    const fresh = new Date()
    const freshActive = await seedCall({
      state: "active",
      createdAt: fresh,
      startedAt: fresh,
      lastHeartbeatAt: fresh,
    })
    const freshStarting = await seedCall({
      state: "starting",
      createdAt: fresh,
    })

    expect(
      (await getCallForAccount(freshActive.accountId, freshActive.callId))?.call
        .state
    ).toBe("active")
    expect(
      (await getCallForAccount(freshStarting.accountId, freshStarting.callId))
        ?.call.state
    ).toBe("starting")
    expect((await storedCall(freshActive.callId)).state).toBe("active")
    expect((await storedCall(freshStarting.callId)).state).toBe("starting")
  })

  it("moves only stale active and starting calls to their honest states", async () => {
    const now = new Date("2026-09-20T10:10:00Z")
    const stale = new Date("2026-09-20T10:00:00Z")
    const fresh = new Date("2026-09-20T10:09:30Z")
    const staleActive = await seedCall({
      state: "active",
      createdAt: stale,
      startedAt: stale,
      lastHeartbeatAt: stale,
      durationSecs: 17.125,
    })
    const freshActive = await seedCall({
      state: "active",
      createdAt: stale,
      startedAt: stale,
      lastHeartbeatAt: fresh,
      durationSecs: 4.5,
    })
    const noHeartbeat = await seedCall({
      state: "active",
      createdAt: stale,
      startedAt: stale,
      lastHeartbeatAt: null,
    })
    const staleStarting = await seedCall({
      state: "starting",
      createdAt: stale,
    })
    const freshStarting = await seedCall({
      state: "starting",
      createdAt: fresh,
    })

    const swept = await sweepStaleCalls(now)
    expect(swept.incomplete).toBeGreaterThanOrEqual(1)
    expect(swept.failed).toBeGreaterThanOrEqual(1)

    expect(await storedCall(staleActive.callId)).toMatchObject({
      state: "incomplete",
      ended_reason: "agent_lost",
      duration_secs: "17.125",
    })
    expect(await storedCall(freshActive.callId)).toMatchObject({
      state: "active",
      ended_reason: null,
      duration_secs: "4.500",
    })
    expect(await storedCall(noHeartbeat.callId)).toMatchObject({
      state: "active",
      ended_reason: null,
    })
    expect(await storedCall(staleStarting.callId)).toMatchObject({
      state: "failed",
      ended_reason: "agent_never_started",
    })
    expect(await storedCall(freshStarting.callId)).toMatchObject({
      state: "starting",
      ended_reason: null,
    })
    expect(await storedEvents(staleActive.callId)).toHaveLength(1)
    expect(await storedEvents(freshActive.callId)).toHaveLength(0)
    expect(await storedEvents(staleStarting.callId)).toHaveLength(0)
  })

  it("returns zero changes from an authenticated second run at the same instant", async () => {
    const now = new Date()
    const stale = new Date(now.getTime() - 10 * 60_000)
    const token = `sweep-integration-${randomUUID()}`
    const previousToken = process.env.CALL_SWEEP_TOKEN
    process.env.CALL_SWEEP_TOKEN = token
    const target = await seedCall({
      state: "active",
      createdAt: stale,
      startedAt: stale,
      lastHeartbeatAt: stale,
    })
    const request = () =>
      new Request("http://localhost:3000/v1/internal/sweep", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      })

    try {
      const first = await handleSweepRequest(request(), now)
      expect(first.status).toBe(200)
      expect(await first.json()).toMatchObject({
        incomplete: expect.any(Number),
        failed: expect.any(Number),
      })

      const second = await handleSweepRequest(request(), now)
      expect(second.status).toBe(200)
      expect(await second.json()).toStrictEqual({ incomplete: 0, failed: 0 })
      expect(await storedCall(target.callId)).toMatchObject({
        state: "incomplete",
        ended_reason: "agent_lost",
      })
      expect(
        (await storedEvents(target.callId)).filter(
          (row) => row.seq === PLATFORM_SWEEP_SEQUENCE
        )
      ).toHaveLength(1)
    } finally {
      if (previousToken === undefined) delete process.env.CALL_SWEEP_TOKEN
      else process.env.CALL_SWEEP_TOKEN = previousToken
    }
  })

  it("uses the reserved range when naive max-plus-one would allocate an agent sequence", async () => {
    const stale = new Date("2026-09-20T10:00:00Z")
    const now = new Date("2026-09-20T10:10:00Z")
    const { callId, rawToken } = await seedCall({
      state: "active",
      startedAt: stale,
      lastHeartbeatAt: stale,
    })
    const agentEvents = [1, 2, 3, 4, 5].map((seq) => event(seq))
    await ingestAgentEvents(callId, rawToken, agentEvents, stale)
    const before = await storedEvents(callId)

    await sweepStaleCalls(now)

    const rows = await storedEvents(callId)
    expect(rows).toHaveLength(6)
    expect(rows.slice(0, 5)).toStrictEqual(before)
    expect(rows[5]?.seq).toBe(PLATFORM_SWEEP_SEQUENCE)
    expect(rows.some((row) => row.seq === 6)).toBe(false)
  })

  it("uses the reserved int4 range even when the agent owns the preceding sequence", async () => {
    const stale = new Date("2026-09-20T10:00:00Z")
    const now = new Date("2026-09-20T10:10:00Z")
    const { callId, rawToken } = await seedCall({
      state: "active",
      startedAt: stale,
      lastHeartbeatAt: stale,
    })
    const agentEvent = event(PLATFORM_SWEEP_SEQUENCE - 1)
    await ingestAgentEvents(callId, rawToken, [agentEvent], stale)
    const before = (await storedEvents(callId))[0]

    await sweepStaleCalls(now)

    const rows = await storedEvents(callId)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toStrictEqual(before)
    expect(rows[1]?.seq).toBe(PLATFORM_SWEEP_SEQUENCE)
    expect(rows[1]?.seq).toBeGreaterThanOrEqual(1_000_000_000)
    expect(rows[1]?.seq).toBeLessThanOrEqual(2_147_483_647)
  })

  it("deduplicates concurrent sweep attempts", async () => {
    const stale = new Date("2026-09-20T10:00:00Z")
    const now = new Date("2026-09-20T10:10:00Z")
    const { callId } = await seedCall({
      state: "active",
      startedAt: stale,
      lastHeartbeatAt: stale,
    })

    const results = await Promise.all([
      sweepStaleCalls(now),
      sweepStaleCalls(now),
    ])

    expect(
      results.reduce((total, result) => total + result.incomplete, 0)
    ).toBe(1)
    expect((await storedCall(callId)).state).toBe("incomplete")
    expect(await storedEvents(callId)).toHaveLength(1)
  })

  it("converges on ended when completion races the sweeper", async () => {
    const stale = new Date("2026-09-20T10:00:00Z")
    const now = new Date("2026-09-20T10:10:00Z")
    const { callId, rawToken } = await seedCall({
      state: "active",
      startedAt: stale,
      lastHeartbeatAt: stale,
    })

    await Promise.all([
      sweepStaleCalls(now),
      completeAgentCall(
        callId,
        rawToken,
        { endedReason: "pipeline_error", durationSecs: 12.345 },
        now
      ),
    ])

    expect(await storedCall(callId)).toMatchObject({
      state: "ended",
      ended_reason: "pipeline_error",
      duration_secs: "12.345",
    })
  })
})
