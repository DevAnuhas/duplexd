import { randomUUID } from "node:crypto"

import { describe, expect, it, vi } from "vitest"

import { PipecatStartError, startPipecatSession } from "@/control/pipecat"

function jwtWithExpiry(exp: number): string {
  const encoded = Buffer.from(JSON.stringify({ exp }), "utf8").toString(
    "base64url"
  )
  return `header.${encoded}.signature`
}

describe("Pipecat Cloud start seam", () => {
  it("sends the agent credential only in the runner body and returns provider join data", async () => {
    const callId = `call-${randomUUID()}`
    const agentToken = `agent-token-${randomUUID()}`
    const expiresAtSeconds = Math.floor(Date.now() / 1_000) + 3_600
    const dailyToken = jwtWithExpiry(expiresAtSeconds)
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    const fetchStub = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ input, init })
        return Response.json({
          sessionId: "provider-session-distinctive",
          dailyRoom: "https://daily.example.invalid/room-distinctive",
          dailyToken,
        })
      }
    ) as typeof fetch

    const result = await startPipecatSession({ callId, agentToken }, fetchStub)

    expect(requests).toHaveLength(1)
    const request = requests[0]!
    const body = JSON.parse(String(request.init?.body)) as Record<
      string,
      unknown
    >
    expect(body).toStrictEqual({
      createDailyRoom: true,
      transport: "daily",
      body: {
        callId,
        apiBase: process.env.BETTER_AUTH_URL,
        agentToken,
      },
    })
    expect(String(request.input)).not.toContain(agentToken)
    expect(JSON.stringify(request.init?.headers)).not.toContain(agentToken)
    expect(result).toStrictEqual({
      sessionId: "provider-session-distinctive",
      dailyRoom: "https://daily.example.invalid/room-distinctive",
      dailyToken,
      expiresAt: new Date(expiresAtSeconds * 1_000).toISOString(),
    })
    expect(JSON.stringify(result)).not.toContain(agentToken)
  })

  it("classifies an upstream 429 as capacity and calls the seam once", async () => {
    const upstreamCanary = `capacity-body-${randomUUID()}`
    const fetchStub = vi.fn(
      async () => new Response(upstreamCanary, { status: 429 })
    ) as typeof fetch

    const error = await captureStartError(fetchStub)

    expect(fetchStub).toHaveBeenCalledTimes(1)
    expect(error).toBeInstanceOf(PipecatStartError)
    expect(error.kind).toBe("capacity")
    expect(String(error)).not.toContain(upstreamCanary)
  })

  it.each([
    [
      "a non-429 response",
      async (canary: string) => new Response(canary, { status: 503 }),
    ],
    [
      "a malformed success body",
      async (canary: string) => new Response(canary, { status: 200 }),
    ],
    [
      "a network failure",
      async (canary: string) => {
        throw new Error(canary)
      },
    ],
  ])(
    "classifies %s as unavailable without reflecting its body",
    async (_label, respond) => {
      const upstreamCanary = `upstream-body-${randomUUID()}`
      const fetchStub = vi.fn(() => respond(upstreamCanary)) as typeof fetch

      const error = await captureStartError(fetchStub)

      expect(fetchStub).toHaveBeenCalledTimes(1)
      expect(error.kind).toBe("unavailable")
      expect(String(error)).not.toContain(upstreamCanary)
    }
  )
})

async function captureStartError(
  fetchImpl: typeof fetch
): Promise<PipecatStartError> {
  try {
    await startPipecatSession(
      { callId: `call-${randomUUID()}`, agentToken: `agent-${randomUUID()}` },
      fetchImpl
    )
  } catch (error) {
    if (error instanceof PipecatStartError) {
      return error
    }

    throw error
  }

  throw new Error("The provider failure path unexpectedly succeeded.")
}
