import { afterEach, describe, expect, it, vi } from "vitest"

import {
  readSandboxProviderEnvironment,
  resolveSandboxAgentApiBase,
  sandboxExecutionConfigured,
} from "@/db/env"
import { createPracticeBrowserMediaVerifier } from "@/sandbox/browser-media"

const complete = {
  PIPECAT_API_KEY: "test-only-public-key",
  PIPECAT_PRIVATE_API_KEY: "test-only-private-key",
  PIPECAT_ORGANIZATION_ID: "e8986b3e-5274-485c-b9d7-80e6137e4be3",
  PIPECAT_SERVICE_ID: "44861c17-f97a-4509-89fd-af7885bdfc78",
  PIPECAT_DEPLOYMENT_ID: "a37796b5-f084-42f0-9df8-333fcc602c5c",
} as const

function configure(overrides: Record<string, string | undefined> = {}): void {
  for (const [name, value] of Object.entries({ ...complete, ...overrides })) {
    vi.stubEnv(name, value)
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe("Sandbox provider configuration", () => {
  it("reads the five variables as one all-or-nothing binding", () => {
    configure()

    expect(readSandboxProviderEnvironment()).toStrictEqual({
      publicApiKey: complete.PIPECAT_API_KEY,
      privateApiKey: complete.PIPECAT_PRIVATE_API_KEY,
      organizationId: complete.PIPECAT_ORGANIZATION_ID,
      serviceId: complete.PIPECAT_SERVICE_ID,
      deploymentId: complete.PIPECAT_DEPLOYMENT_ID,
    })
    expect(sandboxExecutionConfigured()).toBe(true)
  })

  // A partial configuration must not be a partial feature. Each of these,
  // alone, is enough to keep the whole deployment on the 503 boundary.
  it.each(Object.keys(complete))(
    "refuses the whole configuration when %s is missing",
    (name) => {
      configure({ [name]: undefined })

      expect(readSandboxProviderEnvironment()).toBeNull()
      expect(sandboxExecutionConfigured()).toBe(false)
    }
  )

  it.each(Object.keys(complete))("treats a blank %s as absent", (name) => {
    configure({ [name]: "   " })

    expect(readSandboxProviderEnvironment()).toBeNull()
  })

  it("refuses when both keys hold the same credential", () => {
    configure({ PIPECAT_PRIVATE_API_KEY: complete.PIPECAT_API_KEY })

    expect(readSandboxProviderEnvironment()).toBeNull()
  })

  // The failure this rejects is a real one: PIPECAT_ORGANIZATION holds the
  // Pipecat namespace, and pasting it into the UUID field would bind the
  // transport to something no provider response can ever match.
  it.each([
    "duplexd",
    "e8986b3e5274485cb9d780e6137e4be3",
    "e8986b3e-5274-485c-b9d7-80e6137e4be",
    "zzzzzzzz-5274-485c-b9d7-80e6137e4be3",
  ])("refuses %s as an organization binding", (organizationId) => {
    configure({ PIPECAT_ORGANIZATION_ID: organizationId })

    expect(readSandboxProviderEnvironment()).toBeNull()
  })

  it("trims surrounding whitespace rather than failing on it", () => {
    configure({
      PIPECAT_SERVICE_ID: `  ${complete.PIPECAT_SERVICE_ID}\n`,
    })

    expect(readSandboxProviderEnvironment()?.serviceId).toBe(
      complete.PIPECAT_SERVICE_ID
    )
  })
})

describe("the origin the agent calls back on", () => {
  it("falls back to the auth origin when no override is set", () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://duplexd.example")

    expect(resolveSandboxAgentApiBase()).toBe("https://duplexd.example")
  })

  // Local development is the whole reason this exists: the browser keeps
  // localhost so cookies work, the agent gets an HTTPS tunnel it can resolve.
  it("prefers the override so the two origins can differ", () => {
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000")
    vi.stubEnv("SANDBOX_AGENT_API_BASE", "https://tunnel.example")

    expect(resolveSandboxAgentApiBase()).toBe("https://tunnel.example")
  })

  it("ignores a blank override", () => {
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000")
    vi.stubEnv("SANDBOX_AGENT_API_BASE", "  ")

    expect(resolveSandboxAgentApiBase()).toBe("http://localhost:3000")
  })
})

describe("browser media expiry", () => {
  const at = new Date("2026-09-22T09:00:00Z")
  const deadline = new Date("2026-09-22T09:10:00Z")
  const verify = createPracticeBrowserMediaVerifier(() => at)

  function base64url(raw: string): string {
    return Buffer.from(raw).toString("base64url")
  }

  function token(payload: unknown): string {
    return [
      base64url(JSON.stringify({ alg: "HS256" })),
      base64url(JSON.stringify(payload)),
      "not-a-real-signature",
    ].join(".")
  }

  const input = {
    sessionId: "11111111-1111-4111-8111-111111111111",
    dailyRoom: "https://synthetic.daily.co/test",
    maximumExpiresAt: deadline.toISOString(),
  }

  it("uses the token's own expiry when it lands inside the deadline", async () => {
    const exp = Math.floor(deadline.getTime() / 1_000) - 60

    await expect(
      verify({ ...input, dailyToken: token({ exp, r: "test" }) })
    ).resolves.toStrictEqual({
      expiresAt: new Date(exp * 1_000).toISOString(),
    })
  })

  // The platform's committed deadline is the bound, so a token claiming more
  // time than the call has cannot buy any. Clamping, not refusing: the call is
  // still perfectly runnable, it just ends when we said it would.
  it("clamps a token that outlives the execution deadline", async () => {
    const exp = Math.floor(deadline.getTime() / 1_000) + 3_600

    await expect(
      verify({ ...input, dailyToken: token({ exp }) })
    ).resolves.toStrictEqual({ expiresAt: deadline.toISOString() })
  })

  // An opaque token is not a reason to refuse a call we can still bound, so
  // every shape that fails to yield a usable claim lands on the deadline.
  it.each([
    ["an opaque token", "not-a-jwt-at-all"],
    ["a payload that is not base64url", "header.@@@@@.signature"],
    ["a payload that is not JSON", `header.${base64url("{nope")}.signature`],
    ["a payload that is not an object", `header.${base64url('"x"')}.signature`],
    ["a missing exp claim", token({ room: "test" })],
    ["a non-numeric exp", token({ exp: "soon" })],
    ["a fractional exp", token({ exp: 1_790_000_000.5 })],
    ["a negative exp", token({ exp: -1 })],
  ])("falls back to the deadline for %s", async (_label, dailyToken) => {
    await expect(verify({ ...input, dailyToken })).resolves.toStrictEqual({
      expiresAt: deadline.toISOString(),
    })
  })

  // A dead credential is worth refusing rather than clamping: handing the
  // browser a token it cannot use produces a call that fails after the agent
  // has already been started and is already costing money.
  it("refuses a token that has already expired", async () => {
    const exp = Math.floor(at.getTime() / 1_000) - 1

    await expect(
      verify({ ...input, dailyToken: token({ exp }) })
    ).resolves.toBeNull()
  })

  it("refuses an unusable maximum rather than inventing one", async () => {
    const dailyToken = token({ exp: Math.floor(deadline.getTime() / 1_000) })

    await expect(
      verify({ ...input, dailyToken, maximumExpiresAt: "not a date" })
    ).resolves.toBeNull()
    await expect(
      verify({ ...input, dailyToken, maximumExpiresAt: at.toISOString() })
    ).resolves.toBeNull()
  })
})
