import { randomBytes, randomUUID } from "node:crypto"

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import type { SignedUpUser } from "./helpers/auth.ts"

const requestHeaders = { current: new Headers() }

vi.mock("next/headers", () => ({
  headers: async () => requestHeaders.current,
}))

const { GET: getCsrf } = await import("@/app/api/workspace/sandbox/csrf/route")
const { POST: startRoute } =
  await import("@/app/api/workspace/sandbox/attempts/[id]/start/route")
const { POST: joinRoute } =
  await import("@/app/api/workspace/sandbox/attempts/[id]/join/route")
const { POST: presenceRoute } =
  await import("@/app/api/workspace/sandbox/attempts/[id]/presence/route")
const { POST: stopRoute } =
  await import("@/app/api/workspace/sandbox/attempts/[id]/stop/route")
const { createAssistant } = await import("@/data/assistants")
const { closeDb } = await import("@/db/client")
const { hashSandboxControllerProof, prepareSandboxAttempt } =
  await import("@/sandbox/admission")
const { signUpNewAccount } = await import("./helpers/auth.ts")
const { isDatabaseConfigured } = await import("./helpers/environment.ts")

/**
 * The composed Sandbox — environment, transport, lifecycle, routes — driven
 * through the three browser routes with the provider replaced by a fake
 * `fetch` and nothing else.
 *
 * The seam is deliberately as far out as it goes. `sandbox-lifecycle.test.ts`
 * injects a transport object and proves the durable protocol; what it cannot
 * prove is that any environment variable reaches any of it, which is the
 * entire subject of this file. So the only thing faked here is the network:
 * the configuration is read for real, the transport is constructed for real,
 * and a mistake in the wiring shows up as a request to the wrong URL, with the
 * wrong credential, or not at all.
 */

const ORIGIN = "http://localhost:3000"
const TUNNEL = "https://tunnel.test"
const PUBLIC_KEY = "test-only-public-key"
const PRIVATE_KEY = "test-only-private-key"
const BINDING = {
  organizationId: "e8986b3e-5274-485c-b9d7-80e6137e4be3",
  serviceId: "44861c17-f97a-4509-89fd-af7885bdfc78",
  deploymentId: "a37796b5-f084-42f0-9df8-333fcc602c5c",
} as const
const ROOM = "https://synthetic.daily.co/practice"

const describeDatabase = describe.skipIf(!isDatabaseConfigured())

afterAll(closeDb)

function base64url(raw: string): string {
  return Buffer.from(raw).toString("base64url")
}

/** A syntactically real JWT with no real signature and no real authority. */
function mediaToken(expiresAtMs: number): string {
  return [
    base64url(JSON.stringify({ alg: "HS256" })),
    base64url(JSON.stringify({ exp: Math.floor(expiresAtMs / 1_000) })),
    "not-a-real-signature",
  ].join(".")
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

type ProviderCall = {
  method: string
  url: string
  authorization: string | null
  body: Record<string, unknown> | null
}

/**
 * A fake Pipecat. Anything not addressed to it is a bug in this file rather
 * than a call to pass through, so it throws instead of reaching the network.
 */
function fakeProvider(options: { sessionId: string; dailyToken: string }) {
  const calls: ProviderCall[] = []
  let ended = false

  const fetchImpl = async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString()
    const method = init?.method ?? "GET"
    const raw = typeof init?.body === "string" ? init.body : null
    calls.push({
      method,
      url,
      authorization: new Headers(init?.headers).get("authorization"),
      body: raw === null ? null : (JSON.parse(raw) as Record<string, unknown>),
    })

    if (!url.startsWith("https://api.pipecat.daily.co/")) {
      throw new Error(`Unexpected request escaped the test: ${method} ${url}`)
    }
    if (url.endsWith("/start")) {
      return Response.json({
        sessionId: options.sessionId,
        dailyRoom: ROOM,
        dailyToken: options.dailyToken,
      })
    }
    if (method === "DELETE") {
      ended = true
      return Response.json({
        session_id: options.sessionId,
        status: "terminated",
      })
    }
    return Response.json({
      sessionId: options.sessionId,
      ...BINDING,
      createdAt: new Date(Date.now() - 10_000).toISOString(),
      endedAt: ended ? new Date().toISOString() : null,
      completionStatus: ended ? "HTTP_COMPLETED" : null,
    })
  }

  return { calls, fetchImpl: vi.fn(fetchImpl) }
}

async function preparedAttempt() {
  const account = await signUpNewAccount()
  const assistant = await createAssistant(account.accountId, {
    name: `Execution ${randomUUID()}`,
    voice: "marin",
    accentStyle: "Neutral.",
    instructions: "Synthetic data only.",
    backendInstructions: "Answer briefly.",
    backendModel: "gpt-5.6-luna",
    waitingBehavior: "Acknowledge once.",
    tools: [],
  })
  const proof = randomBytes(32).toString("base64url")
  const prepared = await prepareSandboxAttempt({
    accountId: account.accountId,
    userId: account.userId,
    controllerProofHash: hashSandboxControllerProof(proof)!,
    request: {
      clientAttemptId: randomUUID(),
      assistantId: assistant.id,
      baseRevision: 1,
      source: "saved",
    },
  })
  if (prepared.kind !== "created")
    throw new Error(`Prepare failed: ${prepared.kind}`)
  const csrf = await csrfFor(account)
  return {
    account,
    attemptId: prepared.attempt.attemptId,
    request: () =>
      new Request(`${ORIGIN}/attempts/${prepared.attempt.attemptId}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-duplexd-csrf": csrf,
          "x-duplexd-controller-proof": proof,
          origin: ORIGIN,
          "sec-fetch-site": "same-origin",
        },
        body: "{}",
      }),
  }
}

function configureProvider(): void {
  vi.stubEnv("PIPECAT_API_KEY", PUBLIC_KEY)
  vi.stubEnv("PIPECAT_PRIVATE_API_KEY", PRIVATE_KEY)
  vi.stubEnv("PIPECAT_ORGANIZATION_ID", BINDING.organizationId)
  vi.stubEnv("PIPECAT_SERVICE_ID", BINDING.serviceId)
  vi.stubEnv("PIPECAT_DEPLOYMENT_ID", BINDING.deploymentId)
  vi.stubEnv("SANDBOX_AGENT_API_BASE", TUNNEL)
}

describeDatabase("Sandbox execution routes, fake provider only", () => {
  let provider: ReturnType<typeof fakeProvider>
  let sessionId: string

  beforeEach(() => {
    sessionId = randomUUID()
    provider = fakeProvider({
      sessionId,
      dailyToken: mediaToken(Date.now() + 300_000),
    })
    vi.stubGlobal("fetch", provider.fetchImpl)
    configureProvider()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it("starts, joins and renews a configured attempt", async () => {
    const attempt = await preparedAttempt()

    const started = await startRoute(
      attempt.request(),
      routeContext(attempt.attemptId)
    )
    expect(started.status).toBe(200)
    const startBody = (await started.json()) as {
      attempt: Record<string, string>
    }
    expect(startBody.attempt).toMatchObject({
      attemptId: attempt.attemptId,
      execution: "enabled",
      state: "starting",
    })
    expect(startBody.attempt.executionDeadline).toEqual(expect.any(String))

    // The start went to the public endpoint with the public key. Sending the
    // private key here would hand session-termination authority to a request
    // the browser can cause.
    const start = provider.calls.find((call) => call.url.endsWith("/start"))!
    expect(start.url).toBe(
      "https://api.pipecat.daily.co/v1/public/duplexd-agent/start"
    )
    expect(start.authorization).toBe(`Bearer ${PUBLIC_KEY}`)
    expect(start.body).toMatchObject({
      createDailyRoom: true,
      transport: "daily",
      body: { apiBase: TUNNEL, callId: startBody.attempt.callId },
    })
    // The room ejects at the platform's own deadline, which is the bound.
    expect(start.body?.dailyRoomProperties).toMatchObject({
      exp: Math.floor(Date.parse(startBody.attempt.executionDeadline!) / 1_000),
      eject_at_room_exp: true,
    })
    // The agent's callback credential is not the browser's problem.
    expect(JSON.stringify(startBody)).not.toContain("agentToken")

    const joined = await joinRoute(
      attempt.request(),
      routeContext(attempt.attemptId)
    )
    expect(joined.status).toBe(200)
    const joinBody = (await joined.json()) as {
      join: { sessionId: string; dailyRoom: string; expiresAt: string }
    }
    expect(joinBody.join).toMatchObject({ sessionId, dailyRoom: ROOM })
    // The token expires before the deadline, so the verifier's answer wins.
    expect(Date.parse(joinBody.join.expiresAt)).toBeLessThan(
      Date.parse(startBody.attempt.executionDeadline!)
    )

    const renewed = await presenceRoute(
      attempt.request(),
      routeContext(attempt.attemptId)
    )
    expect(renewed.status).toBe(200)
    const presenceBody = (await renewed.json()) as {
      serverTime: string
      presenceExpiresAt: string
      attempt: Record<string, string>
    }
    // The attempt travels with the renewal; without it the browser never sees
    // readiness and ends a healthy call at the startup deadline.
    expect(presenceBody.attempt.attemptId).toBe(attempt.attemptId)
    expect(Date.parse(presenceBody.presenceExpiresAt)).toBeGreaterThan(
      Date.parse(presenceBody.serverTime)
    )
  })

  it("terminates the session with the private key when the user stops", async () => {
    const attempt = await preparedAttempt()
    expect(
      (await startRoute(attempt.request(), routeContext(attempt.attemptId)))
        .status
    ).toBe(200)

    const stopped = await stopRoute(
      attempt.request(),
      routeContext(attempt.attemptId)
    )
    expect(stopped.status).toBe(200)

    const deletes = provider.calls.filter((call) => call.method === "DELETE")
    expect(deletes).toHaveLength(1)
    expect(deletes[0]!.url).toBe(
      `https://api.pipecat.daily.co/v1/agents/duplexd-agent/sessions/${sessionId}`
    )
    expect(deletes[0]!.authorization).toBe(`Bearer ${PRIVATE_KEY}`)
  })

  it("refuses a join whose media credential has already expired", async () => {
    provider = fakeProvider({
      sessionId,
      dailyToken: mediaToken(Date.now() - 1_000),
    })
    vi.stubGlobal("fetch", provider.fetchImpl)
    const attempt = await preparedAttempt()

    // Start still answers, because the attempt is a real attempt that reached
    // a real provider; what it must not do is claim a usable call.
    const started = await startRoute(
      attempt.request(),
      routeContext(attempt.attemptId)
    )
    expect(started.status).toBe(200)
    expect((await started.json()).attempt).toMatchObject({
      state: "start_unknown",
    })

    const joined = await joinRoute(
      attempt.request(),
      routeContext(attempt.attemptId)
    )
    expect(joined.status).toBe(409)
    expect(await joined.json()).toMatchObject({ code: "unavailable" })
  })

  it("answers 503 and dispatches nothing when the binding is incomplete", async () => {
    vi.stubEnv("PIPECAT_DEPLOYMENT_ID", undefined)
    const attempt = await preparedAttempt()

    const started = await startRoute(
      attempt.request(),
      routeContext(attempt.attemptId)
    )
    expect(started.status).toBe(503)
    const body = (await started.json()) as {
      code: string
      attempt: { execution: string }
    }
    expect(body.code).toBe("sandbox_execution_disabled")
    expect(body.attempt.execution).toBe("disabled")
    expect(
      provider.calls.filter((call) =>
        call.url.startsWith("https://api.pipecat.daily.co/")
      )
    ).toHaveLength(0)
  })
})
