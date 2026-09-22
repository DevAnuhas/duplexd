import { inspect } from "node:util"

import { afterEach, describe, expect, it, vi } from "vitest"

import {
  createPipecatSandboxTransport,
  type SandboxBrowserMediaVerifier,
} from "@/sandbox/pipecat-transport"
import { SANDBOX_LIMITS } from "@/sandbox/protocol"

const at = new Date("2026-09-22T09:00:00Z")
const deadline = new Date("2026-09-22T09:10:00Z")
const sessionId = "11111111-1111-4111-8111-111111111111"
const binding = {
  organizationId: "22222222-2222-4222-8222-222222222222",
  serviceId: "33333333-3333-4333-8333-333333333333",
  deploymentId: "44444444-4444-4444-8444-444444444444",
  agentName: "synthetic-agent",
}
const input = {
  callId: "synthetic-call",
  apiBase: "https://platform.example.test",
  agentToken: "CANARY_AGENT_TOKEN",
}
const media = {
  sessionId,
  dailyRoom: "https://synthetic.daily.co/test",
  dailyToken: "CANARY_MEDIA_TOKEN",
}
const running = {
  sessionId,
  organizationId: binding.organizationId,
  serviceId: binding.serviceId,
  deploymentId: binding.deploymentId,
  createdAt: "2026-09-22T08:59:00Z",
  endedAt: null,
  completionStatus: null,
}
const signal = () => new AbortController().signal

function fixture(verifyBrowserMedia?: SandboxBrowserMediaVerifier) {
  const fetch = vi.fn<typeof globalThis.fetch>()
  const retainSession = vi
    .fn<(id: string) => Promise<void>>()
    .mockResolvedValue(undefined)
  const options = {
    publicApiKey: "CANARY_PUBLIC_KEY",
    privateApiKey: "CANARY_PRIVATE_KEY",
    binding: { ...binding },
    fetchImpl: fetch,
    now: () => at,
    verifyBrowserMedia,
  }
  const transport = createPipecatSandboxTransport(options)
  const context = { executionDeadline: deadline, retainSession }
  return {
    fetch,
    retainSession,
    options,
    transport,
    context,
    start: (s = signal()) => transport.start(input, s, context),
  }
}

// This is a trusted TEST-ONLY credential oracle. It parses no token and proves
// nothing about real Daily/Pipecat media capability or current provider claims.
const syntheticVerifier: SandboxBrowserMediaVerifier = async () => ({
  expiresAt: deadline.toISOString(),
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe("Pipecat Sandbox thin transport, fake fetch only", () => {
  it("imports and constructs without environment or network access", async () => {
    const network = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("unexpected network"))
    vi.stubGlobal("fetch", network)
    for (const key of [
      "DATABASE_URL",
      "PIPECAT_API_KEY",
      "ASSISTANT_SECRET_KEY",
    ])
      vi.stubEnv(key, "")
    vi.resetModules()
    const module = await import("@/sandbox/pipecat-transport")
    expect(() =>
      module.createPipecatSandboxTransport({
        publicApiKey: "public",
        privateApiKey: "private",
        binding,
      })
    ).not.toThrow()
    expect(network).not.toHaveBeenCalled()
  })

  it("copies independently configured identities and sends only the documented bounded public start body", async () => {
    const f = fixture(syntheticVerifier)
    f.options.binding.organizationId = "changed-org"
    f.options.binding.serviceId = "changed-service"
    f.options.binding.deploymentId = "changed-deployment"
    f.options.binding.agentName = "changed-agent"
    f.options.publicApiKey = "changed-public"
    f.options.privateApiKey = "changed-private"
    f.fetch
      .mockResolvedValueOnce(Response.json(media))
      .mockResolvedValueOnce(Response.json(running))
    expect(await f.start()).toEqual({
      kind: "started",
      join: { ...media, expiresAt: deadline.toISOString() },
    })
    const [url, request] = f.fetch.mock.calls[0]!
    expect(url).toBe(
      "https://api.pipecat.daily.co/v1/public/synthetic-agent/start"
    )
    expect(request).toMatchObject({
      method: "POST",
      redirect: "error",
      cache: "no-store",
      headers: {
        authorization: "Bearer CANARY_PUBLIC_KEY",
        "content-type": "application/json",
      },
    })
    expect(JSON.parse(String(request!.body))).toEqual({
      createDailyRoom: true,
      transport: "daily",
      dailyRoomProperties: {
        exp: deadline.getTime() / 1000,
        eject_at_room_exp: true,
        enable_screenshare: false,
        start_video_off: true,
      },
      dailyMeetingTokenProperties: {
        exp: deadline.getTime() / 1000,
        eject_at_token_exp: true,
        is_owner: false,
        enable_screenshare: false,
        start_video_off: true,
      },
      body: input,
    })
    expect(Object.keys(JSON.parse(String(request!.body)).body).sort()).toEqual([
      "agentToken",
      "apiBase",
      "callId",
    ])
    expect(await f.transport.read(sessionId, signal())).toEqual({
      kind: "session",
      sessionId,
      binding,
      state: "running",
    })
    expect(f.fetch.mock.calls[1]).toEqual([
      `https://api.pipecat.daily.co/v1/agents/synthetic-agent/sessions/${sessionId}`,
      expect.objectContaining({
        method: "GET",
        redirect: "error",
        headers: {
          authorization: "Bearer CANARY_PRIVATE_KEY",
          "content-type": "application/json",
        },
      }),
    ])
  })

  it.each(["organizationId", "serviceId", "deploymentId"] as const)(
    "rejects an organization namespace or missing UUID in %s without inferring it from sessions",
    (field) => {
      const f = fixture()
      for (const value of ["namespace-is-not-a-uuid", ""]) {
        expect(() =>
          createPipecatSandboxTransport({
            ...f.options,
            binding: { ...binding, [field]: value },
          })
        ).toThrow("invalid_configuration")
      }
      expect(f.fetch).not.toHaveBeenCalled()
    }
  )

  it("requires distinct public/private credentials and a safe configured agent name", () => {
    const f = fixture()
    for (const overrides of [
      { publicApiKey: "" },
      { privateApiKey: f.options.publicApiKey },
      { privateApiKey: "CANARY\nsecret" },
      { binding: { ...binding, agentName: "../different" } },
      // Runtime callers must not coerce missing configuration into the path "undefined".
      { binding: { ...binding, agentName: undefined as unknown as string } },
    ]) {
      expect(() =>
        createPipecatSandboxTransport({ ...f.options, ...overrides })
      ).toThrow("invalid_configuration")
    }
    expect(f.fetch).not.toHaveBeenCalled()
  })

  it.each([0, -1, SANDBOX_LIMITS.executionMs + 1_000, NaN])(
    "rejects an invalid execution deadline offset %s without dispatch",
    async (offset) => {
      const f = fixture()
      f.context.executionDeadline = new Date(at.getTime() + offset)
      expect(await f.start()).toEqual({ kind: "definite_no_start" })
      expect(f.fetch).not.toHaveBeenCalled()
    }
  )

  it.each([400, 401])(
    "treats HTTP %s without a session identity as definite rejection",
    async (status) => {
      const f = fixture()
      f.fetch.mockResolvedValue(
        new Response("CANARY_PROVIDER_BODY", { status })
      )
      expect(await f.start()).toEqual({ kind: "definite_no_start" })
      expect(f.fetch).toHaveBeenCalledTimes(1)
      expect(f.retainSession).not.toHaveBeenCalled()
    }
  )

  it.each([400, 401, 403, 429, 500, 503])(
    "retains an observed identity before returning unknown on HTTP %s",
    async (status) => {
      const f = fixture()
      f.fetch.mockResolvedValue(
        Response.json({ ...media, error: "CANARY_PROVIDER_BODY" }, { status })
      )
      expect(await f.start()).toEqual({
        kind: "unknown",
        reason: "http_unknown",
      })
      expect(f.retainSession).toHaveBeenCalledExactlyOnceWith(sessionId)
      expect(f.fetch).toHaveBeenCalledTimes(1)
    }
  )

  it.each([403, 429, 500, 503, 302])(
    "does not infer no-start or retry HTTP %s",
    async (status) => {
      const f = fixture()
      f.fetch.mockResolvedValue(
        new Response("CANARY_PROVIDER_BODY", { status })
      )
      expect(await f.start()).toEqual({
        kind: "unknown",
        reason: "http_unknown",
      })
      expect(f.fetch).toHaveBeenCalledTimes(1)
    }
  )

  it("retains exact identity and denies join without a real media verifier", async () => {
    const f = fixture()
    f.fetch.mockResolvedValue(Response.json(media))
    expect(await f.start()).toEqual({
      kind: "unknown",
      reason: "browser_media_contract_unverified",
    })
    expect(f.retainSession).toHaveBeenCalledExactlyOnceWith(sessionId)
  })

  it.each([
    { dailyRoom: "http://synthetic.daily.co/test" },
    { dailyRoom: "https://evil.example/test" },
    { dailyRoom: "https://synthetic.daily.co/test?CANARY_QUERY" },
    { dailyToken: "" },
    { dailyToken: null },
    { sessionId: "bounded-but-not-uuid" },
  ])(
    "persists identity before rejecting malformed media %j",
    async (override) => {
      const verify = vi.fn(syntheticVerifier)
      const f = fixture(verify)
      f.fetch.mockResolvedValue(Response.json({ ...media, ...override }))
      expect(await f.start()).toMatchObject({ kind: "unknown" })
      expect(f.retainSession).toHaveBeenCalledExactlyOnceWith(
        override.sessionId ?? sessionId
      )
      expect(verify).not.toHaveBeenCalled()
    }
  )

  it("awaits durable identity retention before invoking the trusted test verifier or returning", async () => {
    let release!: () => void
    const persisted = new Promise<void>((resolve) => {
      release = resolve
    })
    const verify = vi.fn(syntheticVerifier)
    const f = fixture(verify)
    f.retainSession.mockReturnValue(persisted)
    f.fetch.mockResolvedValue(Response.json(media))
    let settled = false
    const result = f.start().then((value) => {
      settled = true
      return value
    })
    await vi.waitFor(() =>
      expect(f.retainSession).toHaveBeenCalledExactlyOnceWith(sessionId)
    )
    expect(settled).toBe(false)
    expect(verify).not.toHaveBeenCalled()
    release()
    expect(await result).toMatchObject({ kind: "started" })
    expect(verify).toHaveBeenCalledExactlyOnceWith({
      ...media,
      maximumExpiresAt: deadline.toISOString(),
    })
  })

  it("retention failure denies join and redacts the persistence cause", async () => {
    const verify = vi.fn(syntheticVerifier)
    const f = fixture(verify)
    f.fetch.mockResolvedValue(Response.json(media))
    f.retainSession.mockRejectedValue(new Error("CANARY_DATABASE_PARAMETERS"))
    expect(await f.start()).toEqual({
      kind: "unknown",
      reason: "identity_persistence_failed",
    })
    expect(verify).not.toHaveBeenCalled()
  })

  it("awaits retention before returning an unknown HTTP outcome", async () => {
    let release!: () => void
    const retained = new Promise<void>((resolve) => {
      release = resolve
    })
    const f = fixture()
    f.retainSession.mockReturnValue(retained)
    f.fetch.mockResolvedValue(Response.json(media, { status: 401 }))
    let settled = false
    const pending = f.start().then((result) => {
      settled = true
      return result
    })
    await vi.waitFor(() =>
      expect(f.retainSession).toHaveBeenCalledExactlyOnceWith(sessionId)
    )
    expect(settled).toBe(false)
    release()
    expect(await pending).toEqual({ kind: "unknown", reason: "http_unknown" })
  })

  it("never releases a join when cancellation occurs during the trusted test verifier", async () => {
    let release!: (credential: { expiresAt: string }) => void
    const verified = new Promise<{ expiresAt: string }>((resolve) => {
      release = resolve
    })
    const verify = vi.fn(async () => verified)
    const f = fixture(verify)
    f.fetch.mockResolvedValue(Response.json(media))
    const abort = new AbortController()
    const pending = f.start(abort.signal)
    await vi.waitFor(() => expect(verify).toHaveBeenCalledTimes(1))
    abort.abort()
    release({ expiresAt: deadline.toISOString() })
    expect(await pending).toEqual({
      kind: "unknown",
      reason: "network_unknown",
    })
    expect(f.retainSession).toHaveBeenCalledExactlyOnceWith(sessionId)
  })

  it.each([
    null,
    { expiresAt: at.toISOString() },
    { expiresAt: new Date(deadline.getTime() + 1).toISOString() },
    { expiresAt: "malformed" },
    { expiresAt: "2026-09-22 09:05:00Z" },
  ])(
    "denies synthetic verifier expiry outside the execution lease: %j",
    async (credential) => {
      const f = fixture(async () => credential)
      f.fetch.mockResolvedValue(Response.json(media))
      expect(await f.start()).toEqual({
        kind: "unknown",
        reason: "browser_media_contract_unverified",
      })
      expect(f.retainSession).toHaveBeenCalledExactlyOnceWith(sessionId)
    }
  )

  it("keeps verifier exceptions and provider credentials out of results and logs", async () => {
    const logs = [
      vi.spyOn(console, "error"),
      vi.spyOn(console, "warn"),
      vi.spyOn(console, "log"),
    ]
    const f = fixture(async () => {
      throw new Error("CANARY_VERIFIER_SECRET")
    })
    f.fetch
      .mockResolvedValueOnce(
        Response.json({ ...media, error: "CANARY_PROVIDER_BODY" })
      )
      .mockRejectedValueOnce(new Error("CANARY_NETWORK_SECRET"))
    const results = [await f.start(), await f.start()]
    expect(results.every((result) => result.kind === "unknown")).toBe(true)
    expect(inspect(results)).not.toMatch(/CANARY|daily\.co/)
    for (const log of logs) expect(log).not.toHaveBeenCalled()
    expect(f.fetch).toHaveBeenCalledTimes(2)
  })

  it.each(["{", "null", "[]", "{}"])(
    "treats malformed success %s as unknown",
    async (body) => {
      const f = fixture()
      f.fetch.mockResolvedValue(new Response(body))
      expect(await f.start()).toEqual({
        kind: "unknown",
        reason: "malformed_response",
      })
      expect(f.fetch).toHaveBeenCalledTimes(1)
    }
  )

  it("bounds streamed bodies without Content-Length and cancels the reader", async () => {
    const cancel = vi.fn()
    const f = fixture()
    f.fetch.mockResolvedValue(
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(128 * 1024))
          },
          cancel,
        })
      )
    )
    expect(await f.start()).toEqual({
      kind: "unknown",
      reason: "response_too_large",
    })
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(f.fetch).toHaveBeenCalledTimes(1)
  })

  it("rejects a declared oversized body without consuming it", async () => {
    const f = fixture()
    f.fetch.mockResolvedValue(
      new Response("{}", {
        headers: { "content-length": String(256 * 1024 + 1) },
      })
    )
    expect(await f.start()).toEqual({
      kind: "unknown",
      reason: "response_too_large",
    })
  })

  it("treats a disconnected response stream as unknown without retry", async () => {
    const f = fixture()
    f.fetch.mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("CANARY_DISCONNECT"))
          },
        })
      )
    )
    expect(await f.start()).toEqual({
      kind: "unknown",
      reason: "network_unknown",
    })
    expect(f.fetch).toHaveBeenCalledTimes(1)
  })

  it("aborts a pending body read, cancels its stream, and returns unknown", async () => {
    const cancel = vi.fn()
    const f = fixture()
    f.fetch.mockResolvedValue(new Response(new ReadableStream({ cancel })))
    const abort = new AbortController()
    const pending = f.start(abort.signal)
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(1))
    abort.abort()
    expect(await pending).toEqual({
      kind: "unknown",
      reason: "network_unknown",
    })
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(f.fetch.mock.calls[0]![1]!.signal!.aborted).toBe(true)
  })

  it("bounds an uncooperative fetch with a timeout and never retries it", async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.fetch.mockImplementation(() => new Promise(() => {}))
    const pending = f.start()
    await vi.advanceTimersByTimeAsync(SANDBOX_LIMITS.dispatchMs)
    expect(await pending).toEqual({
      kind: "unknown",
      reason: "network_unknown",
    })
    expect(f.fetch).toHaveBeenCalledTimes(1)
    expect(f.fetch.mock.calls[0]![1]!.signal!.aborted).toBe(true)
  })

  it("never dispatches an already-aborted request", async () => {
    const f = fixture()
    const abort = new AbortController()
    abort.abort()
    expect(await f.start(abort.signal)).toEqual({
      kind: "unknown",
      reason: "network_unknown",
    })
    expect(f.fetch).not.toHaveBeenCalled()
  })

  it.each([
    "sessionId",
    "organizationId",
    "serviceId",
    "deploymentId",
  ] as const)("refuses read/stop when exact %s mismatches", async (field) => {
    const f = fixture()
    f.fetch.mockImplementation(async () =>
      Response.json({
        ...running,
        [field]: "55555555-5555-4555-8555-555555555555",
      })
    )
    expect(await f.transport.read(sessionId, signal())).toEqual({
      kind: "forbidden",
    })
    await expect(f.transport.stop(sessionId, signal())).rejects.toThrow(
      "forbidden"
    )
    expect(f.fetch.mock.calls.map(([, request]) => request!.method)).toEqual([
      "GET",
      "GET",
    ])
  })

  it.each([401, 403, 404])(
    "does not DELETE after a private GET %s",
    async (status) => {
      const f = fixture()
      f.fetch.mockImplementation(async () =>
        Response.json({ error: "CANARY_PRIVATE_BODY" }, { status })
      )
      await expect(f.transport.stop(sessionId, signal())).rejects.toThrow(
        status === 404 ? "not_found" : "forbidden"
      )
      expect(f.fetch).toHaveBeenCalledTimes(1)
      expect(f.fetch.mock.calls[0]![1]!.method).toBe("GET")
    }
  )

  it.each([
    "sessionId",
    "organizationId",
    "serviceId",
    "deploymentId",
  ] as const)(
    "keeps missing/malformed %s uncertain without deriving identity from configuration",
    async (field) => {
      for (const value of [undefined, "namespace-is-not-a-uuid"]) {
        const f = fixture()
        f.fetch.mockImplementation(async () =>
          Response.json({ ...running, [field]: value })
        )
        expect(await f.transport.read(sessionId, signal())).toEqual({
          kind: "unknown",
        })
        await expect(f.transport.stop(sessionId, signal())).rejects.toThrow(
          "http_unknown"
        )
        expect(
          f.fetch.mock.calls.map(([, request]) => request!.method)
        ).toEqual(["GET", "GET"])
      }
    }
  )

  it.each([
    { endedAt: null, completionStatus: "completed" },
    { endedAt: "2026-09-22T08:59:30Z", completionStatus: null },
    { endedAt: "2026-09-22T08:59:30Z", completionStatus: "" },
    { endedAt: "2026-09-22T09:00:01Z", completionStatus: "completed" },
    { endedAt: "2026-09-22T08:58:00Z", completionStatus: "completed" },
    { endedAt: "invalid", completionStatus: "completed" },
    { createdAt: "2026-09-22T09:00:01Z" },
    { createdAt: undefined },
    { createdAt: "1", endedAt: "2", completionStatus: "completed" },
    { endedAt: "2026-09-22 08:59:30Z", completionStatus: "completed" },
  ])(
    "requires coherent exact-session timestamps for terminal proof %j",
    async (override) => {
      const f = fixture()
      f.fetch.mockImplementation(async () =>
        Response.json({ ...running, ...override })
      )
      expect(await f.transport.read(sessionId, signal())).toEqual({
        kind: "unknown",
      })
      await expect(f.transport.stop(sessionId, signal())).rejects.toThrow(
        "http_unknown"
      )
      expect(
        f.fetch.mock.calls.every(([, request]) => request!.method === "GET")
      ).toBe(true)
    }
  )

  it("internally rechecks exact bound GET before DELETE; acknowledgement is not terminal proof", async () => {
    const f = fixture()
    f.fetch
      .mockResolvedValueOnce(Response.json(running))
      .mockResolvedValueOnce(
        Response.json({ session_id: sessionId, status: "terminated" })
      )
      .mockResolvedValueOnce(Response.json(running))
    await expect(f.transport.stop(sessionId, signal())).resolves.toBeUndefined()
    expect(
      f.fetch.mock.calls.map(([url, request]) => [url, request!.method])
    ).toEqual([
      [
        `https://api.pipecat.daily.co/v1/agents/synthetic-agent/sessions/${sessionId}`,
        "GET",
      ],
      [
        `https://api.pipecat.daily.co/v1/agents/synthetic-agent/sessions/${sessionId}`,
        "DELETE",
      ],
    ])
    for (const [, request] of f.fetch.mock.calls) {
      expect(request).toMatchObject({
        redirect: "error",
        headers: { authorization: "Bearer CANARY_PRIVATE_KEY" },
      })
      expect(request!.body).toBeUndefined()
    }
    expect(await f.transport.read(sessionId, signal())).toMatchObject({
      state: "running",
    })
  })

  it("recognizes only matching terminal GET and skips unnecessary DELETE", async () => {
    const f = fixture()
    f.fetch.mockImplementation(async () =>
      Response.json({
        ...running,
        endedAt: "2026-09-22T08:59:30Z",
        completionStatus: "completed",
      })
    )
    expect(await f.transport.read(sessionId, signal())).toEqual({
      kind: "session",
      sessionId,
      binding,
      state: "stopped",
    })
    await f.transport.stop(sessionId, signal())
    expect(f.fetch.mock.calls.map(([, request]) => request!.method)).toEqual([
      "GET",
      "GET",
    ])
  })

  it.each([401, 403, 404, 500])(
    "keeps DELETE %s errors redacted and does not retry",
    async (status) => {
      const f = fixture()
      f.fetch
        .mockResolvedValueOnce(Response.json(running))
        .mockResolvedValueOnce(
          Response.json({ error: "CANARY_DELETE_BODY" }, { status })
        )
      const error: unknown = await f.transport
        .stop(sessionId, signal())
        .catch((value: unknown) => value)
      expect(error).toBeInstanceOf(Error)
      expect(inspect(error)).not.toContain("CANARY")
      expect(f.fetch).toHaveBeenCalledTimes(2)
    }
  )

  it.each([
    {
      session_id: "55555555-5555-4555-8555-555555555555",
      status: "terminated",
    },
    { session_id: sessionId, status: "running" },
    { status: "terminated" },
  ])(
    "rejects a mismatched or malformed DELETE acknowledgement %j",
    async (acknowledgement) => {
      const f = fixture()
      f.fetch
        .mockResolvedValueOnce(Response.json(running))
        .mockResolvedValueOnce(Response.json(acknowledgement))
      await expect(f.transport.stop(sessionId, signal())).rejects.toThrow(
        "malformed_response"
      )
      expect(f.fetch).toHaveBeenCalledTimes(2)
    }
  )
})
