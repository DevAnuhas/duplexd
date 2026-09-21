import { randomBytes, randomUUID } from "node:crypto"

import { afterAll, describe, expect, it, vi } from "vitest"

import type { SignedUpUser } from "./helpers/auth.ts"

const requestHeaders = { current: new Headers() }

vi.mock("next/headers", () => ({
  headers: async () => requestHeaders.current,
}))

const provider = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn() }))
vi.mock("@/control/pipecat", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/control/pipecat")>()),
  startPipecatSession: provider.start,
  stopPipecatSession: provider.stop,
}))

const { GET: getCsrf } = await import("@/app/api/workspace/sandbox/csrf/route")
const { POST: prepareRoute } =
  await import("@/app/api/workspace/sandbox/attempts/route")
const { GET: currentRoute } =
  await import("@/app/api/workspace/sandbox/attempts/current/route")
const { GET: statusRoute } =
  await import("@/app/api/workspace/sandbox/attempts/[id]/route")
const { POST: startRoute } =
  await import("@/app/api/workspace/sandbox/attempts/[id]/start/route")
const { POST: joinRoute } =
  await import("@/app/api/workspace/sandbox/attempts/[id]/join/route")
const { POST: presenceRoute } =
  await import("@/app/api/workspace/sandbox/attempts/[id]/presence/route")
const { POST: stopRoute } =
  await import("@/app/api/workspace/sandbox/attempts/[id]/stop/route")
const { POST: createPublicCall } = await import("@/app/v1/calls/route")
const { createAssistant } = await import("@/data/assistants")
const { listCallsForAccount } = await import("@/data/calls")
const { closeDb, getDb } = await import("@/db/client")
const { calls, sandboxAttempts, sandboxSlots, users } =
  await import("@/db/schema")
const {
  cancelSandboxAttempt,
  expireSandboxReservations,
  getCurrentSandboxAttempt,
  hashSandboxControllerProof,
  prepareSandboxAttempt,
  refuseDisabledSandboxExecution,
  SANDBOX_ACCOUNT_ADMISSIONS_PER_WINDOW,
  SANDBOX_ACCOUNT_UNRESOLVED_LIMIT,
  SANDBOX_RESERVATION_MS,
  SANDBOX_USER_ADMISSIONS_PER_WINDOW,
} = await import("@/sandbox/admission")
const { signUpNewAccount } = await import("./helpers/auth.ts")
const { isDatabaseConfigured } = await import("./helpers/environment.ts")
const { withTestPool } = await import("./helpers/database.ts")
const { and, eq } = await import("drizzle-orm")

const describeDatabase = describe.skipIf(!isDatabaseConfigured())
const ORIGIN = "http://localhost:3000"

afterAll(async () => {
  await closeDb()
})

function controllerProof(): string {
  return randomBytes(32).toString("base64url")
}

function routeContext(id: string) {
  return { params: Promise.resolve({ id }) }
}

async function csrfFor(account: SignedUpUser): Promise<string> {
  requestHeaders.current = new Headers({ cookie: account.cookie })
  const response = await getCsrf()
  expect(response.status).toBe(200)
  return ((await response.json()) as { token: string }).token
}

function mutationRequest(
  path: string,
  body: unknown,
  input: {
    csrf?: string
    proof?: string
    origin?: string
    fetchSite?: string
  } = {}
): Request {
  const headers = new Headers({ "content-type": "application/json" })
  if (input.csrf !== undefined) headers.set("x-duplexd-csrf", input.csrf)
  if (input.proof !== undefined)
    headers.set("x-duplexd-controller-proof", input.proof)
  if (input.origin !== undefined) headers.set("origin", input.origin)
  if (input.fetchSite !== undefined)
    headers.set("sec-fetch-site", input.fetchSite)
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
}

async function fixture() {
  const account = await signUpNewAccount()
  const assistant = await createAssistant(account.accountId, {
    name: `Sandbox ${randomUUID()}`,
    voice: "marin",
    accentStyle: "Neutral and direct.",
    instructions: "Use only synthetic test data.",
    backendInstructions: "Answer briefly.",
    backendModel: "gpt-5.6-luna",
    waitingBehavior: "Acknowledge once.",
    tools: [],
  })
  const proof = controllerProof()
  const proofHash = hashSandboxControllerProof(proof)
  expect(proofHash).not.toBeNull()
  return { account, assistant, proof, proofHash: proofHash! }
}

function prepareInput(assistantId: string, clientAttemptId = randomUUID()) {
  return {
    clientAttemptId,
    assistantId,
    baseRevision: 1,
    source: "saved" as const,
  }
}

async function directPrepare(
  setup: Awaited<ReturnType<typeof fixture>>,
  overrides: Partial<Parameters<typeof prepareSandboxAttempt>[0]> = {}
) {
  return prepareSandboxAttempt({
    accountId: setup.account.accountId,
    userId: setup.account.userId,
    controllerProofHash: setup.proofHash,
    request: prepareInput(setup.assistant.id),
    ...overrides,
  })
}

describeDatabase("provider-independent Sandbox foundation", () => {
  it("atomically replays identical same-attempt requests and conflicts changed input", async () => {
    const setup = await fixture()
    const request = prepareInput(setup.assistant.id)
    const results = await Promise.all([
      directPrepare(setup, { request }),
      directPrepare(setup, { request }),
    ])

    expect(results.map((result) => result.kind).sort()).toStrictEqual([
      "created",
      "replay",
    ])
    const attempts = results.flatMap((result) =>
      "attempt" in result ? [result.attempt] : []
    )
    expect(new Set(attempts.map((attempt) => attempt.attemptId)).size).toBe(1)
    expect(new Set(attempts.map((attempt) => attempt.callId)).size).toBe(1)

    expect(
      await directPrepare(setup, {
        request: { ...request, scenarioRevision: 1 },
      })
    ).toStrictEqual({ kind: "attempt_conflict" })

    const counts = await withTestPool(async (pool) => {
      const { rows } = await pool.query<{ attempts: string; calls: string }>(
        `SELECT
           (SELECT count(*) FROM sandbox_attempts WHERE account_id = $1)::text AS attempts,
           (SELECT count(*) FROM calls WHERE account_id = $1 AND source = 'sandbox')::text AS calls`,
        [setup.account.accountId]
      )
      return rows[0]!
    })
    expect(counts).toStrictEqual({ attempts: "1", calls: "1" })
  })

  it("atomically excludes concurrent different attempts for the same user", async () => {
    const setup = await fixture()
    const results = await Promise.all([
      directPrepare(setup),
      directPrepare(setup),
    ])
    expect(results.map((result) => result.kind).sort()).toStrictEqual([
      "created",
      "user_slot_occupied",
    ])
    const created = results.find((result) => result.kind === "created")
    const occupied = results.find(
      (result) => result.kind === "user_slot_occupied"
    )
    if (
      created?.kind !== "created" ||
      occupied?.kind !== "user_slot_occupied"
    ) {
      throw new Error("concurrent admission returned unexpected results")
    }
    expect(occupied.attempt.attemptId).toBe(created.attempt.attemptId)
  })

  it("enforces the per-user admission quota without charging replays", async () => {
    const setup = await fixture()
    const now = new Date("2035-01-01T00:00:00.000Z")
    const replayId = randomUUID()
    const first = await directPrepare(setup, {
      now,
      request: prepareInput(setup.assistant.id, replayId),
    })
    expect(first.kind).toBe("created")
    expect(
      await directPrepare(setup, {
        now,
        request: prepareInput(setup.assistant.id, replayId),
      })
    ).toMatchObject({ kind: "replay" })
    if (!("attempt" in first)) throw new Error("attempt was not created")
    await cancelSandboxAttempt({
      accountId: setup.account.accountId,
      userId: setup.account.userId,
      attemptId: first.attempt.attemptId,
      now,
    })

    for (let index = 1; index < SANDBOX_USER_ADMISSIONS_PER_WINDOW; index++) {
      const result = await directPrepare(setup, { now })
      expect(result.kind).toBe("created")
      if (!("attempt" in result)) throw new Error("attempt was not created")
      await cancelSandboxAttempt({
        accountId: setup.account.accountId,
        userId: setup.account.userId,
        attemptId: result.attempt.attemptId,
        now,
      })
    }
    expect(await directPrepare(setup, { now })).toStrictEqual({
      kind: "user_rate_exceeded",
    })
  })

  it("enforces the account admission quota across distinct users", async () => {
    const setup = await fixture()
    const now = new Date("2035-02-01T00:00:00.000Z")
    const extraUsers = Array.from(
      { length: SANDBOX_ACCOUNT_ADMISSIONS_PER_WINDOW },
      () => ({
        id: randomUUID(),
        accountId: setup.account.accountId,
        email: `${randomUUID()}@example.invalid`,
        name: "Synthetic Sandbox member",
      })
    )
    await getDb().insert(users).values(extraUsers)

    for (const user of extraUsers) {
      const result = await prepareSandboxAttempt({
        accountId: setup.account.accountId,
        userId: user.id,
        controllerProofHash: setup.proofHash,
        request: prepareInput(setup.assistant.id),
        now,
      })
      expect(result.kind).toBe("created")
      if (!("attempt" in result)) throw new Error("attempt was not created")
      await cancelSandboxAttempt({
        accountId: setup.account.accountId,
        userId: user.id,
        attemptId: result.attempt.attemptId,
        now,
      })
    }

    const overflowUser = {
      id: randomUUID(),
      accountId: setup.account.accountId,
      email: `${randomUUID()}@example.invalid`,
      name: "Synthetic overflow member",
    }
    await getDb().insert(users).values(overflowUser)
    expect(
      await prepareSandboxAttempt({
        accountId: setup.account.accountId,
        userId: overflowUser.id,
        controllerProofHash: setup.proofHash,
        request: prepareInput(setup.assistant.id),
        now,
      })
    ).toStrictEqual({ kind: "account_rate_exceeded" })
  })

  it("caps unresolved account slots across distinct users", async () => {
    const setup = await fixture()
    const members = Array.from(
      { length: SANDBOX_ACCOUNT_UNRESOLVED_LIMIT + 1 },
      () => ({
        id: randomUUID(),
        accountId: setup.account.accountId,
        email: `${randomUUID()}@example.invalid`,
        name: "Synthetic concurrent Sandbox member",
      })
    )
    await getDb().insert(users).values(members)

    const results = await Promise.all(
      members.map((user) =>
        prepareSandboxAttempt({
          accountId: setup.account.accountId,
          userId: user.id,
          controllerProofHash: setup.proofHash,
          request: prepareInput(setup.assistant.id),
        })
      )
    )
    expect(results.filter((result) => result.kind === "created")).toHaveLength(
      SANDBOX_ACCOUNT_UNRESOLVED_LIMIT
    )
    expect(
      results.filter((result) => result.kind === "account_capacity_exceeded")
    ).toHaveLength(1)
  })

  it("expires reservations and cancels pre-dispatch without credentials or provider work", async () => {
    const setup = await fixture()
    const preparedAt = new Date("2035-03-01T00:00:00.000Z")
    const expiring = await directPrepare(setup, { now: preparedAt })
    if (!("attempt" in expiring)) throw new Error("attempt was not created")
    expect(
      await expireSandboxReservations(
        new Date(preparedAt.getTime() + SANDBOX_RESERVATION_MS)
      )
    ).toBeGreaterThanOrEqual(1)
    expect(
      await getCurrentSandboxAttempt({
        accountId: setup.account.accountId,
        userId: setup.account.userId,
      })
    ).toBeNull()

    const canceling = await directPrepare(setup, {
      now: new Date("2035-03-01T00:01:00.000Z"),
    })
    if (!("attempt" in canceling)) throw new Error("attempt was not created")
    expect(
      await cancelSandboxAttempt({
        accountId: setup.account.accountId,
        userId: setup.account.userId,
        attemptId: canceling.attempt.attemptId,
        now: new Date("2035-03-01T00:01:01.000Z"),
      })
    ).toMatchObject({ kind: "canceled", attempt: { state: "canceled" } })

    const rows = await getDb()
      .select({
        state: calls.state,
        agentTokenHash: calls.agentTokenHash,
        providerSession: calls.pipecatSessionId,
        dailyRoom: calls.dailyRoom,
        practiceSecret: calls.practiceSecretCiphertext,
      })
      .from(calls)
      .where(eq(calls.id, canceling.attempt.callId))
    expect(rows[0]).toStrictEqual({
      state: "failed",
      agentTokenHash: null,
      providerSession: null,
      dailyRoom: null,
      practiceSecret: null,
    })
    expect(provider.start).not.toHaveBeenCalled()
    expect(provider.stop).not.toHaveBeenCalled()
  })

  it("makes foreign account attempts indistinguishable from missing attempts", async () => {
    const owner = await fixture()
    const intruder = await fixture()
    const created = await directPrepare(owner)
    if (!("attempt" in created)) throw new Error("attempt was not created")
    requestHeaders.current = new Headers({ cookie: intruder.account.cookie })

    const foreign = await statusRoute(
      new Request(ORIGIN),
      routeContext(created.attempt.attemptId)
    )
    const missing = await statusRoute(
      new Request(ORIGIN),
      routeContext(randomUUID())
    )
    expect(foreign.status).toBe(404)
    expect(await foreign.text()).toBe(await missing.text())

    expect(
      await refuseDisabledSandboxExecution({
        accountId: owner.account.accountId,
        userId: intruder.account.userId,
        attemptId: created.attempt.attemptId,
        controllerProofHash: owner.proofHash,
      })
    ).toStrictEqual({ kind: "not_owner" })
  })

  it("guards mutations with session, Origin, same-site metadata, CSRF, and controller proof", async () => {
    const setup = await fixture()
    const csrf = await csrfFor(setup.account)
    const body = prepareInput(setup.assistant.id)
    const base = { csrf, proof: setup.proof, origin: ORIGIN }

    requestHeaders.current = new Headers()
    expect(
      (await prepareRoute(mutationRequest("/attempts", body, base))).status
    ).toBe(401)
    requestHeaders.current = new Headers({ cookie: setup.account.cookie })
    expect(
      (
        await prepareRoute(
          mutationRequest("/attempts", body, { ...base, origin: undefined })
        )
      ).status
    ).toBe(403)
    expect(
      (
        await prepareRoute(
          mutationRequest("/attempts", body, {
            ...base,
            origin: "https://evil.example.invalid",
          })
        )
      ).status
    ).toBe(403)
    expect(
      (
        await prepareRoute(
          mutationRequest("/attempts", body, {
            ...base,
            fetchSite: "cross-site",
          })
        )
      ).status
    ).toBe(403)
    expect(
      (
        await prepareRoute(
          mutationRequest("/attempts", body, { ...base, csrf: undefined })
        )
      ).status
    ).toBe(403)
    expect(
      (
        await prepareRoute(
          mutationRequest("/attempts", body, { ...base, proof: "invalid" })
        )
      ).status
    ).toBe(403)

    const accepted = await prepareRoute(
      mutationRequest("/attempts", body, { ...base, fetchSite: "same-origin" })
    )
    expect(accepted.status).toBe(201)
  })

  it("returns safe DTOs and hard-disables start, join, and presence with zero provider calls", async () => {
    provider.start.mockClear()
    provider.stop.mockClear()
    const setup = await fixture()
    const csrf = await csrfFor(setup.account)
    const prepared = await prepareRoute(
      mutationRequest("/attempts", prepareInput(setup.assistant.id), {
        csrf,
        proof: setup.proof,
        origin: ORIGIN,
        fetchSite: "same-origin",
      })
    )
    const preparedBody = (await prepared.json()) as {
      attempt: Record<string, unknown>
    }
    const attemptId = String(preparedBody.attempt.attemptId)
    const expectedKeys = [
      "assistantId",
      "attemptId",
      "baseAssistantRevision",
      "callId",
      "callState",
      "canceledAt",
      "configSource",
      "execution",
      "expiredAt",
      "preparedAt",
      "reservationExpiresAt",
      "source",
      "state",
      "stopRequestedAt",
      "testMode",
    ]
    expect(Object.keys(preparedBody.attempt).sort()).toStrictEqual(
      expectedKeys.sort()
    )

    requestHeaders.current = new Headers({ cookie: setup.account.cookie })
    const current = await currentRoute()
    const status = await statusRoute(
      new Request(ORIGIN),
      routeContext(attemptId)
    )
    for (const response of [current, status]) {
      expect(response.status).toBe(200)
      const text = await response.text()
      expect(text).not.toMatch(/controller|credential|token|daily|room|secret/i)
    }

    for (const route of [startRoute, joinRoute, presenceRoute]) {
      const response = await route(
        mutationRequest(
          `/attempts/${attemptId}`,
          {},
          {
            csrf,
            proof: setup.proof,
            origin: ORIGIN,
            fetchSite: "same-origin",
          }
        ),
        routeContext(attemptId)
      )
      expect(response.status).toBe(503)
      const body = (await response.json()) as Record<string, unknown>
      expect(body).toMatchObject({ code: "sandbox_execution_disabled" })
      expect(JSON.stringify(body)).not.toMatch(
        /agentToken|joinCredential|dailyToken|roomUrl/
      )
    }

    const wrongController = await startRoute(
      mutationRequest(
        `/attempts/${attemptId}`,
        {},
        {
          csrf,
          proof: controllerProof(),
          origin: ORIGIN,
          fetchSite: "same-origin",
        }
      ),
      routeContext(attemptId)
    )
    expect(wrongController.status).toBe(403)
    expect(await wrongController.json()).toMatchObject({
      code: "invalid_controller_proof",
    })

    const stored = await getDb()
      .select({
        agentTokenHash: calls.agentTokenHash,
        providerSession: calls.pipecatSessionId,
        dailyRoom: calls.dailyRoom,
        practiceSecret: calls.practiceSecretCiphertext,
      })
      .from(calls)
      .where(eq(calls.id, String(preparedBody.attempt.callId)))
    expect(stored[0]).toStrictEqual({
      agentTokenHash: null,
      providerSession: null,
      dailyRoom: null,
      practiceSecret: null,
    })
    const publicCalls = await listCallsForAccount(setup.account.accountId)
    expect(publicCalls).toMatchObject({ kind: "ok", calls: [] })
    expect(provider.start).not.toHaveBeenCalled()
    expect(provider.stop).not.toHaveBeenCalled()
  })

  it("does not let a workspace cookie authenticate the public call API", async () => {
    provider.start.mockClear()
    const setup = await fixture()
    const response = await createPublicCall(
      new Request(`${ORIGIN}/v1/calls`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: setup.account.cookie,
        },
        body: JSON.stringify({ assistantId: setup.assistant.id }),
      })
    )
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ code: "invalid_api_key" })
    expect(provider.start).not.toHaveBeenCalled()
  })

  it("checks controller proof and refuses provider cleanup for a non-prepared state", async () => {
    const setup = await fixture()
    const created = await directPrepare(setup)
    if (!("attempt" in created)) throw new Error("attempt was not created")
    expect(
      await refuseDisabledSandboxExecution({
        accountId: setup.account.accountId,
        userId: setup.account.userId,
        attemptId: created.attempt.attemptId,
        controllerProofHash: hashSandboxControllerProof(controllerProof())!,
      })
    ).toStrictEqual({ kind: "invalid_controller" })

    await getDb()
      .update(sandboxAttempts)
      .set({ state: "dispatch_unknown" })
      .where(eq(sandboxAttempts.id, created.attempt.attemptId))
    const result = await cancelSandboxAttempt({
      accountId: setup.account.accountId,
      userId: setup.account.userId,
      attemptId: created.attempt.attemptId,
    })
    expect(result).toMatchObject({ kind: "provider_cleanup_disabled" })
    const slot = await getDb()
      .select({ attemptId: sandboxSlots.attemptId })
      .from(sandboxSlots)
      .where(
        and(
          eq(sandboxSlots.accountId, setup.account.accountId),
          eq(sandboxSlots.userId, setup.account.userId)
        )
      )
    expect(slot).toStrictEqual([{ attemptId: created.attempt.attemptId }])

    const csrf = await csrfFor(setup.account)
    const response = await stopRoute(
      mutationRequest(
        `/attempts/${created.attempt.attemptId}/stop`,
        {},
        {
          csrf,
          origin: ORIGIN,
          fetchSite: "same-origin",
        }
      ),
      routeContext(created.attempt.attemptId)
    )
    expect(response.status).toBe(503)
    expect(provider.stop).not.toHaveBeenCalled()
  })
})
