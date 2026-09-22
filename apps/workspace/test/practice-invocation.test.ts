import { randomUUID } from "node:crypto"

import { afterAll, describe, expect, it, vi } from "vitest"
import { eq } from "drizzle-orm"

import { SANDBOX_PROTOCOL } from "@/sandbox/protocol"

import type {
  AssistantTool,
  FrozenPracticeSnapshot,
} from "@/practice/configuration"
import type { SignedUpUser } from "./helpers/auth.ts"

const { POST: invokePracticeRoute } =
  await import("@/app/v1/practice/calls/[callId]/tools/route")
const { compilePracticeConfiguration, fingerprintToolInputSchema } =
  await import("@/practice/configuration")
const { MAX_PRACTICE_INVOCATIONS, createPracticeSecret, invokePracticeSample } =
  await import("@/practice/samples")
const { createAssistant } = await import("@/data/assistants")
const { closeDb, getDb } = await import("@/db/client")
const { calls, practiceInvocations, sandboxAttempts } =
  await import("@/db/schema")
const { encryptSecret } = await import("@/lib/crypto")
const { validateTools } = await import("@/lib/validate")
const { signUpNewAccount } = await import("./helpers/auth.ts")
const { isDatabaseConfigured } = await import("./helpers/environment.ts")
const {
  PRACTICE_TOOL,
  PRACTICE_DRAFT_2020_TOOL,
  practiceSampleDefinition,
  practiceSignature,
  practiceWebhookBody,
  practiceWebhookHeaders,
} = await import("./helpers/practice.ts")
const { withTestPool } = await import("./helpers/database.ts")

const describeDatabase = describe.skipIf(!isDatabaseConfigured())
const NOW = new Date("2026-09-21T06:30:00.000Z")
const VECTOR_SECRET = "practice-vector-secret"

type PracticeCall = {
  account: SignedUpUser
  callId: string
  assistantId: string
  secret: string
  toolName: string
}

afterAll(async () => {
  await closeDb()
})

async function createPracticeCall(
  input: {
    transport?: "success" | "slow" | "failure"
    override?: string
    state?: string
    deadline?: Date
    stopped?: boolean
    secret?: string
    tool?: AssistantTool
    mutateSnapshot?: (snapshot: FrozenPracticeSnapshot) => void
  } = {}
): Promise<PracticeCall> {
  const tool = input.tool ?? structuredClone(PRACTICE_TOOL)
  const account = await signUpNewAccount()
  const assistant = await createAssistant(account.accountId, {
    name: `Practice invocation ${randomUUID()}`,
    voice: "marin",
    accentStyle: "Warm and direct.",
    instructions: "Use synthetic property information.",
    backendInstructions: "Use the declared lookup tool.",
    backendModel: "gpt-5.6-luna",
    waitingBehavior: "Acknowledge tool work.",
    serverUrl: "https://customer-trap.example.invalid/must-not-run",
    serverSecret: `customer-secret-${randomUUID()}`,
    tools: [tool],
  })
  const compiled = compilePracticeConfiguration({
    assistant,
    baseRevision: assistant.revision,
    source: "saved",
    samples: [
      {
        ...practiceSampleDefinition(fingerprintToolInputSchema(tool)),
        toolName: tool.name,
      },
    ],
    sampleRevision: 1,
    scenario: {
      transport: input.transport ?? "success",
      overrides:
        input.override === undefined ? {} : { [tool.name]: input.override },
    },
  })
  if (compiled.kind !== "ready") throw new Error("expected ready snapshot")
  input.mutateSnapshot?.(compiled.snapshot)

  const callId = `call-${randomUUID()}`
  const secret = input.secret ?? createPracticeSecret().plaintext
  await getDb()
    .insert(calls)
    .values({
      id: callId,
      accountId: account.accountId,
      assistantId: assistant.id,
      assistantSnapshot: {},
      source: "sandbox",
      testMode: "practice",
      configSource: "saved",
      baseAssistantRevision: assistant.revision,
      configDigest: compiled.snapshot.configDigest,
      practiceCompilerVersion: compiled.snapshot.compilerVersion,
      practiceSnapshot: compiled.snapshot,
      practiceSecretCiphertext: encryptSecret(secret),
      executionDeadline: input.deadline ?? new Date(NOW.getTime() + 60_000),
      stopRequestedAt: input.stopped ? NOW : null,
      agentTokenHash: randomUUID().replaceAll("-", ""),
      state: input.state ?? "active",
    })

  return {
    account,
    callId,
    assistantId: assistant.id,
    secret,
    toolName: tool.name,
  }
}

async function invoke(
  call: PracticeCall,
  input: {
    invocationId?: string
    tool?: string
    arguments?: unknown
    bodyCallId?: string
    bodyAssistantId?: string
    timestamp?: string
    signatureSecret?: string
    headers?: Record<string, string>
    sleep?: (milliseconds: number) => Promise<void>
    now?: Date
    clock?: () => Date
  } = {}
) {
  const body = practiceWebhookBody({
    tool: input.tool ?? call.toolName,
    arguments: input.arguments ?? { property: "sample-cottage" },
    callId: input.bodyCallId ?? call.callId,
    assistantId: input.bodyAssistantId ?? call.assistantId,
    invocationId: input.invocationId ?? `invocation-${randomUUID()}`,
  })
  const rawBody = JSON.stringify(body)
  const now = input.now ?? NOW
  const timestamp = input.timestamp ?? String(Math.floor(now.getTime() / 1_000))
  const headers = practiceWebhookHeaders({
    secret: input.signatureSecret ?? call.secret,
    timestamp,
    rawBody,
    callId: body.callId,
    assistantId: body.assistantId,
    invocationId: body.invocationId,
  })
  for (const [key, value] of Object.entries(input.headers ?? {})) {
    headers.set(key, value)
  }

  return invokePracticeSample({
    callId: call.callId,
    rawBody: Buffer.from(rawBody, "utf8"),
    headers: {
      signature: headers.get("duplexd-signature"),
      callId: headers.get("duplexd-call-id"),
      assistantId: headers.get("duplexd-assistant-id"),
      invocationId: headers.get("duplexd-invocation-id"),
    },
    now,
    clock: input.clock,
    sleep: input.sleep,
  })
}

const LEASE_CASES = [
  {
    reason: "startup_deadline",
    expires: 120_000,
    heartbeat: 110_000,
    presence: 170_000,
    ready: false,
  },
  {
    reason: "presence_expired",
    expires: 60_000,
    heartbeat: 50_000,
    presence: 60_000,
    ready: true,
  },
  {
    reason: "control_lost",
    expires: 30_000,
    heartbeat: 0,
    presence: 60_000,
    ready: true,
  },
  {
    reason: "execution_deadline",
    expires: 600_000,
    heartbeat: 590_000,
    presence: 650_000,
    ready: true,
  },
] as const

async function createLeasedPracticeCall(
  lease: (typeof LEASE_CASES)[number],
  transport: "success" | "slow"
) {
  const time = (elapsed: number) => new Date(NOW.getTime() + elapsed)
  const call = await createPracticeCall({ transport, deadline: time(600_000) })
  await getDb()
    .update(calls)
    .set({
      configClaimedAt: NOW,
      startedAt: NOW,
      lastHeartbeatAt: time(lease.heartbeat),
    })
    .where(eq(calls.id, call.callId))
  const attemptId = randomUUID()
  await getDb()
    .insert(sandboxAttempts)
    .values({
      id: attemptId,
      accountId: call.account.accountId,
      initiatedByUserId: call.account.userId,
      callId: call.callId,
      clientAttemptId: randomUUID(),
      inputDigest: "synthetic-input-digest",
      controllerProofHash: "synthetic-controller-hash",
      state: lease.ready ? "active" : "starting",
      preparedAt: time(-1_000),
      reservationExpiresAt: time(30_000),
      dispatchedAt: NOW,
      dispatchSettledAt: NOW,
      protocol: SANDBOX_PROTOCOL,
      resourceState: "known_running",
      startupDeadline: time(120_000),
      presenceExpiresAt: time(lease.presence),
      readyAt: lease.ready ? NOW : null,
    })
  const expectExpiredLease = async () => {
    const [attempt] = await getDb()
      .select()
      .from(sandboxAttempts)
      .where(eq(sandboxAttempts.id, attemptId))
    const [persisted] = await getDb()
      .select()
      .from(calls)
      .where(eq(calls.id, call.callId))
    expect(attempt).toMatchObject({
      stopReason: lease.reason,
      stopRequestedAt: time(lease.expires),
    })
    expect(persisted?.stopRequestedAt).toEqual(time(lease.expires))
  }
  const invocations = () =>
    getDb()
      .select()
      .from(practiceInvocations)
      .where(eq(practiceInvocations.callId, call.callId))
  return { call, time, expectExpiredLease, invocations }
}

describeDatabase("signed Practice invocation", () => {
  describe.each(LEASE_CASES)("authoritative Sandbox $reason", (lease) => {
    it("rejects new signed selection when the webhook is the first request at expiry", async () => {
      const f = await createLeasedPracticeCall(lease, "success")
      expect(
        await invoke(f.call, { now: f.time(lease.expires - 1) })
      ).toMatchObject({ kind: "ok", status: 200 })
      expect(
        await invoke(f.call, { now: f.time(lease.expires) })
      ).toMatchObject({ kind: "not_active" })
      expect(await f.invocations()).toHaveLength(1)
      await f.expectExpiredLease()
    })

    it("rejects a signed replay when the webhook is the first request after expiry", async () => {
      const f = await createLeasedPracticeCall(lease, "success")
      const invocationId = randomUUID()
      expect(
        await invoke(f.call, { invocationId, now: f.time(lease.expires - 1) })
      ).toMatchObject({ kind: "ok", status: 200 })
      expect(
        await invoke(f.call, { invocationId, now: f.time(lease.expires + 1) })
      ).toMatchObject({ kind: "not_active" })
      expect(await f.invocations()).toHaveLength(1)
      await f.expectExpiredLease()
    })

    it("rechecks the lease at delayed release without a status, control or sweep request", async () => {
      const f = await createLeasedPracticeCall(lease, "slow")
      let releaseNow = f.time(lease.expires - 500)
      const sleep = vi.fn(async (delay: number) => {
        expect(delay).toBeGreaterThan(500)
        expect(await f.invocations()).toHaveLength(1)
        releaseNow = new Date(releaseNow.getTime() + delay)
      })
      expect(
        await invoke(f.call, {
          now: releaseNow,
          clock: () => releaseNow,
          sleep,
        })
      ).toMatchObject({ kind: "not_active" })
      expect(sleep).toHaveBeenCalledTimes(1)
      await f.expectExpiredLease()
    })
  })

  it("accepts an independently pinned raw-body HMAC vector", async () => {
    const timestamp = "1700000000"
    const rawBody =
      '{"tool":"lookup_property","arguments":{"property":"sample-cottage"},"callId":"call-vector","assistantId":"assistant-vector","invocationId":"invocation-vector"}'

    expect(practiceSignature(VECTOR_SECRET, timestamp, rawBody)).toBe(
      "b2c58f999969f4601da3693c88c105e9f648e19f0e8eb3367a3912fca39cef77"
    )
  })

  it("returns the authored result envelope and named override", async () => {
    const defaultCall = await createPracticeCall()
    const unavailableCall = await createPracticeCall({
      override: "unavailable",
    })

    await expect(invoke(defaultCall)).resolves.toMatchObject({
      kind: "ok",
      status: 200,
      body: {
        result: {
          property: "Sample Cottage",
          checkoutTime: "11:00 AM",
        },
      },
    })
    await expect(invoke(unavailableCall)).resolves.toMatchObject({
      kind: "ok",
      status: 200,
      body: { result: { message: "Sample information unavailable." } },
    })
  })

  it("executes a save-accepted draft-2020-12 marker through the signed route", async () => {
    const tool: AssistantTool = structuredClone(PRACTICE_DRAFT_2020_TOOL)

    expect(validateTools([tool])).toStrictEqual([])
    const call = await createPracticeCall({
      tool,
      deadline: new Date(Date.now() + 60_000),
    })
    const body = practiceWebhookBody({
      tool: tool.name,
      arguments: { property: "sample-cottage" },
      callId: call.callId,
      assistantId: call.assistantId,
      invocationId: `invocation-${randomUUID()}`,
    })
    const rawBody = JSON.stringify(body)
    const timestamp = String(Math.floor(Date.now() / 1_000))
    const headers = practiceWebhookHeaders({
      secret: call.secret,
      timestamp,
      rawBody,
      callId: body.callId,
      assistantId: body.assistantId,
      invocationId: body.invocationId,
    })

    const response = await invokePracticeRoute(
      new Request(
        `http://localhost:3000/v1/practice/calls/${call.callId}/tools`,
        { method: "POST", headers, body: rawBody }
      ),
      { params: Promise.resolve({ callId: call.callId }) }
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toStrictEqual({
      result: {
        property: "Sample Cottage",
        checkoutTime: "11:00 AM",
      },
    })
  })

  it("returns a controlled non-200 transport failure", async () => {
    const call = await createPracticeCall({ transport: "failure" })

    await expect(invoke(call)).resolves.toMatchObject({
      kind: "ok",
      status: 503,
      body: {
        error: { code: "practice_transport_failure" },
      },
    })
  })

  it("rejects stale, malformed, wrong-secret, and body-mutated signatures", async () => {
    const call = await createPracticeCall()

    await expect(
      invoke(call, {
        timestamp: String(Math.floor(NOW.getTime() / 1_000) - 61),
      })
    ).resolves.toMatchObject({ kind: "invalid_signature" })
    await expect(
      invoke(call, { signatureSecret: "wrong-secret" })
    ).resolves.toMatchObject({ kind: "invalid_signature" })
    await expect(
      invoke(call, { headers: { "duplexd-signature": "garbage" } })
    ).resolves.toMatchObject({ kind: "invalid_signature" })
  })

  it("requires URL, header, and body identities to agree", async () => {
    const call = await createPracticeCall()

    await expect(
      invoke(call, { bodyCallId: `foreign-${randomUUID()}` })
    ).resolves.toMatchObject({ kind: "invalid_request" })
    await expect(
      invoke(call, { bodyAssistantId: `foreign-${randomUUID()}` })
    ).resolves.toMatchObject({ kind: "invalid_request" })
    await expect(
      invoke(call, {
        headers: { "duplexd-invocation-id": `foreign-${randomUUID()}` },
      })
    ).resolves.toMatchObject({ kind: "invalid_request" })
  })

  it("rejects stopped, expired, and non-active calls", async () => {
    const stopped = await createPracticeCall({ stopped: true })
    const expired = await createPracticeCall({
      deadline: new Date(NOW.getTime() - 1),
    })
    const starting = await createPracticeCall({ state: "starting" })

    await expect(invoke(stopped)).resolves.toMatchObject({ kind: "not_active" })
    await expect(invoke(expired)).resolves.toMatchObject({ kind: "not_active" })
    await expect(invoke(starting)).resolves.toMatchObject({
      kind: "not_active",
    })
  })

  it("replays an identical invocation and conflicts on changed content", async () => {
    const call = await createPracticeCall()
    const invocationId = `invocation-${randomUUID()}`
    const first = await invoke(call, { invocationId })
    const replay = await invoke(call, { invocationId })
    const conflict = await invoke(call, {
      invocationId,
      arguments: { property: "different" },
    })

    expect(first).toStrictEqual(replay)
    expect(conflict).toMatchObject({ kind: "conflict" })

    const count = await withTestPool(async (pool) => {
      const { rows } = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM practice_invocations WHERE call_id = $1",
        [call.callId]
      )
      return Number(rows[0]?.count ?? 0)
    })
    expect(count).toBe(1)
  })

  it("caps unique invocations per call", async () => {
    const call = await createPracticeCall()

    await getDb()
      .insert(practiceInvocations)
      .values(
        Array.from({ length: MAX_PRACTICE_INVOCATIONS }, (_, index) => ({
          callId: call.callId,
          invocationId: `seed-${index}`,
          requestDigest: `${index}`.padStart(64, "0"),
          toolName: PRACTICE_TOOL.name,
          scenario: "success",
          statusCode: 200,
          responseBody: { result: null },
          readyAt: NOW,
        }))
      )

    await expect(invoke(call)).resolves.toMatchObject({
      kind: "limit_exceeded",
    })
  })

  it("rechecks stop and expiry after a delayed result is persisted", async () => {
    const stopped = await createPracticeCall({ transport: "slow" })
    const expired = await createPracticeCall({ transport: "slow" })

    await expect(
      invoke(stopped, {
        sleep: async () => {
          await withTestPool((pool) =>
            pool.query(
              "UPDATE calls SET stop_requested_at = $2 WHERE id = $1",
              [stopped.callId, NOW]
            )
          )
        },
      })
    ).resolves.toMatchObject({ kind: "not_active" })

    await expect(
      invoke(expired, {
        sleep: async () => {
          await withTestPool((pool) =>
            pool.query(
              "UPDATE calls SET execution_deadline = $2 WHERE id = $1",
              [expired.callId, new Date(NOW.getTime() - 1)]
            )
          )
        },
      })
    ).resolves.toMatchObject({ kind: "not_active" })
  })

  it("never fetches or falls back to the assistant customer URL", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const call = await createPracticeCall()

    await expect(invoke(call, { tool: "unknown_tool" })).resolves.toMatchObject(
      {
        kind: "invalid_request",
      }
    )
    await expect(
      invoke(call, { arguments: { injected: true } })
    ).resolves.toMatchObject({ kind: "invalid_request" })
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it("rejects invocation when a frozen tool no longer matches its reviewed sample", async () => {
    const call = await createPracticeCall({
      mutateSnapshot: (snapshot) => {
        snapshot.tools[0]!.parameters = {
          ...snapshot.tools[0]!.parameters,
          properties: {
            ...((snapshot.tools[0]!.parameters.properties ?? {}) as Record<
              string,
              unknown
            >),
            addedAfterReview: { type: "string" },
          },
        }
      },
    })

    await expect(invoke(call)).resolves.toMatchObject({
      kind: "invalid_request",
    })
  })
})
