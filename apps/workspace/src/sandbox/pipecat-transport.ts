import { PIPECAT_START_ORIGIN } from "@/control/constants"

import {
  SANDBOX_LIMITS,
  validSandboxIdentity,
  type SandboxBinding,
  type SandboxJoin,
  type SandboxTransport,
} from "./protocol"

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const RESPONSE_BYTES = 256 * 1024

type Failure =
  | "invalid_configuration"
  | "network_unknown"
  | "http_unknown"
  | "malformed_response"
  | "response_too_large"
  | "identity_persistence_failed"
  | "forbidden"
  | "not_found"
  | "browser_media_contract_unverified"

/** Fixed categories only: no provider body, credential, URL or cause. */
export class SandboxProviderError extends Error {
  constructor(readonly category: Failure) {
    super(`Sandbox provider: ${category}`)
  }
}

/**
 * Trusted server/test seam, NOT an enable switch or a JWT decoder. The public
 * start contract does not prove the returned token is the browser's non-owner,
 * room-scoped audio credential, or how to validate its effective ejection claims.
 * No default live verifier is provided. Claims requested on POST are not proof.
 */
export type SandboxBrowserMediaVerifier = (input: {
  sessionId: string
  dailyRoom: string
  dailyToken: string
  maximumExpiresAt: string
}) => Promise<{ expiresAt: string } | null>

type Options = {
  publicApiKey: string
  privateApiKey: string
  /** Independently verified UUIDs, NOT an organization namespace/slug. */
  binding: SandboxBinding
  fetchImpl?: typeof fetch
  now?: () => Date
  verifyBrowserMedia?: SandboxBrowserMediaVerifier
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function validKey(value: unknown): value is string {
  return typeof value === "string" && /^[\x21-\x7e]{1,4096}$/.test(value)
}

function timestamp(value: unknown): number {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value
    )
    ? Date.parse(value)
    : NaN
}

function validRoom(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false
  try {
    const url = new URL(value)
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash &&
      /^[a-z0-9-]+\.daily\.co$/.test(url.hostname) &&
      /^\/[A-Za-z0-9_-]+$/.test(url.pathname)
    )
  } catch {
    return false
  }
}

async function readJson(
  response: Response,
  signal: AbortSignal
): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) throw new SandboxProviderError("malformed_response")
  const chunks: Uint8Array[] = []
  let bytes = 0
  const cancel = () => {
    void reader.cancel().catch(() => {})
  }
  signal.addEventListener("abort", cancel, { once: true })
  try {
    if (signal.aborted) throw new SandboxProviderError("network_unknown")
    const declared = Number(response.headers.get("content-length"))
    if (Number.isFinite(declared) && declared > RESPONSE_BYTES)
      throw new SandboxProviderError("response_too_large")
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > RESPONSE_BYTES)
        throw new SandboxProviderError("response_too_large")
      chunks.push(chunk.value)
    }
    try {
      return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"))
    } catch {
      throw new SandboxProviderError("malformed_response")
    }
  } catch (error) {
    // Do not wait for a hostile/disconnected stream's cancel acknowledgement.
    void reader.cancel().catch(() => {})
    throw error
  } finally {
    signal.removeEventListener("abort", cancel)
    reader.releaseLock()
  }
}

/** Side-effect-free construction. No environment, metadata or credential reads. */
export function createPipecatSandboxTransport(
  options: Options
): SandboxTransport {
  const binding = { ...options.binding }
  if (
    !validKey(options.publicApiKey) ||
    !validKey(options.privateApiKey) ||
    options.publicApiKey === options.privateApiKey ||
    ![binding.organizationId, binding.serviceId, binding.deploymentId].every(
      (v) => typeof v === "string" && UUID.test(v)
    ) ||
    typeof binding.agentName !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(binding.agentName)
  )
    throw new SandboxProviderError("invalid_configuration")
  // Copy configuration; later caller mutation cannot change the verified target.
  const { publicApiKey, privateApiKey, verifyBrowserMedia } = options
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? (() => new Date())
  const agentPath = encodeURIComponent(binding.agentName)

  async function request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    key: string,
    signal: AbortSignal,
    consume: (
      response: Response,
      value: unknown,
      requestSignal: AbortSignal
    ) => Promise<T>,
    body?: unknown
  ): Promise<T> {
    const abort = new AbortController()
    let rejectAborted: (error: SandboxProviderError) => void = () => {}
    const onAbort = () => {
      abort.abort()
      rejectAborted(new SandboxProviderError("network_unknown"))
    }
    const canceled = new Promise<never>((_, reject) => {
      rejectAborted = reject
    })
    signal.addEventListener("abort", onAbort, { once: true })
    const timer = setTimeout(onAbort, SANDBOX_LIMITS.dispatchMs)
    try {
      if (signal.aborted) throw new SandboxProviderError("network_unknown")
      const { response, value } = await Promise.race([
        canceled,
        (async () => {
          const response = await fetchImpl(`${PIPECAT_START_ORIGIN}${path}`, {
            method,
            redirect: "error",
            cache: "no-store",
            headers: {
              authorization: `Bearer ${key}`,
              "content-type": "application/json",
            },
            signal: abort.signal,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          })
          let value: unknown
          try {
            value = await readJson(response, abort.signal)
          } catch (error) {
            // An HTTP rejection remains observable even if its error body is not JSON.
            if (response.status === 200) throw error
          }
          return { response, value }
        })(),
      ])
      // Only remote work races the deadline. Once observed, identity persistence
      // is owned by this request until it settles, even after HTTP cancellation.
      return await consume(response, value, abort.signal)
    } catch (error) {
      if (error instanceof SandboxProviderError) throw error
      throw new SandboxProviderError("network_unknown")
    } finally {
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      abort.abort()
    }
  }

  const sessionPath = (sessionId: string) =>
    `/v1/agents/${agentPath}/sessions/${encodeURIComponent(sessionId)}`

  async function read(
    sessionId: string,
    signal: AbortSignal
  ): ReturnType<SandboxTransport["read"]> {
    if (!UUID.test(sessionId)) return { kind: "unknown" }
    try {
      return await request(
        "GET",
        sessionPath(sessionId),
        privateApiKey,
        signal,
        async (response, value) => {
          if (response.status === 401 || response.status === 403)
            return { kind: "forbidden" }
          if (response.status === 404) return { kind: "not_found" }
          if (response.status !== 200 || !object(value))
            return { kind: "unknown" }
          if (
            ![
              value.sessionId,
              value.organizationId,
              value.serviceId,
              value.deploymentId,
            ].every((v) => typeof v === "string" && UUID.test(v))
          )
            return { kind: "unknown" }
          if (
            value.sessionId !== sessionId ||
            value.organizationId !== binding.organizationId ||
            value.serviceId !== binding.serviceId ||
            value.deploymentId !== binding.deploymentId
          )
            return { kind: "forbidden" }
          const created = timestamp(value.createdAt)
          if (!Number.isFinite(created) || created > now().getTime())
            return { kind: "unknown" }
          if (value.endedAt === null && value.completionStatus === null)
            return {
              kind: "session",
              sessionId,
              binding: { ...binding },
              state: "running",
            }
          const ended = timestamp(value.endedAt)
          if (
            Number.isFinite(ended) &&
            ended >= created &&
            ended <= now().getTime() &&
            typeof value.completionStatus === "string" &&
            value.completionStatus.length > 0
          )
            return {
              kind: "session",
              sessionId,
              binding: { ...binding },
              state: "stopped",
            }
          return { kind: "unknown" }
        }
      )
    } catch {
      return { kind: "unknown" }
    }
  }

  return {
    async start(input, signal, context) {
      const expires = Math.floor(context.executionDeadline.getTime() / 1000)
      if (
        !validSandboxIdentity(input.callId) ||
        !validKey(input.agentToken) ||
        !Number.isSafeInteger(expires) ||
        expires * 1000 <= now().getTime() ||
        expires * 1000 > now().getTime() + SANDBOX_LIMITS.executionMs
      )
        return { kind: "definite_no_start" }
      try {
        const apiBase = new URL(input.apiBase)
        if (
          apiBase.protocol !== "https:" ||
          apiBase.username ||
          apiBase.password ||
          apiBase.search ||
          apiBase.hash
        )
          return { kind: "definite_no_start" }
      } catch {
        return { kind: "definite_no_start" }
      }
      try {
        return await request(
          "POST",
          `/v1/public/${agentPath}/start`,
          publicApiKey,
          signal,
          async (response, value, requestSignal) => {
            const sessionId =
              object(value) && validSandboxIdentity(value.sessionId)
                ? value.sessionId
                : null
            // Persist every bounded exact identity, even when status/media is invalid.
            if (sessionId !== null) {
              try {
                await context.retainSession(sessionId)
              } catch {
                throw new SandboxProviderError("identity_persistence_failed")
              }
            }
            if (
              sessionId === null &&
              (response.status === 400 || response.status === 401)
            )
              return { kind: "definite_no_start" }
            if (response.status !== 200)
              return { kind: "unknown", reason: "http_unknown" }
            if (!sessionId || !UUID.test(sessionId) || !object(value))
              return { kind: "unknown", reason: "malformed_response" }
            if (
              requestSignal.aborted ||
              !validRoom(value.dailyRoom) ||
              !validKey(value.dailyToken) ||
              !verifyBrowserMedia
            )
              return {
                kind: "unknown",
                reason: "browser_media_contract_unverified",
              }
            let credential: { expiresAt: string } | null
            let cancelVerification: () => void = () => {}
            try {
              const canceled = new Promise<null>((resolve) => {
                cancelVerification = () => resolve(null)
              })
              requestSignal.addEventListener("abort", cancelVerification, {
                once: true,
              })
              credential = await Promise.race([
                canceled,
                verifyBrowserMedia({
                  sessionId,
                  dailyRoom: value.dailyRoom,
                  dailyToken: value.dailyToken,
                  maximumExpiresAt: new Date(expires * 1000).toISOString(),
                }),
              ])
            } catch {
              return {
                kind: "unknown",
                reason: "browser_media_contract_unverified",
              }
            } finally {
              requestSignal.removeEventListener("abort", cancelVerification)
            }
            const expiry = credential ? timestamp(credential.expiresAt) : NaN
            if (
              !Number.isFinite(expiry) ||
              expiry <= now().getTime() ||
              expiry > expires * 1000 ||
              requestSignal.aborted
            )
              return {
                kind: "unknown",
                reason: "browser_media_contract_unverified",
              }
            const join: SandboxJoin = {
              sessionId,
              dailyRoom: value.dailyRoom,
              dailyToken: value.dailyToken,
              expiresAt: new Date(expiry).toISOString(),
            }
            return { kind: "started", join }
          },
          {
            createDailyRoom: true,
            transport: "daily",
            dailyRoomProperties: {
              exp: expires,
              eject_at_room_exp: true,
              enable_screenshare: false,
              start_video_off: true,
            },
            dailyMeetingTokenProperties: {
              exp: expires,
              eject_at_token_exp: true,
              is_owner: false,
              enable_screenshare: false,
              start_video_off: true,
            },
            body: {
              callId: input.callId,
              apiBase: input.apiBase,
              agentToken: input.agentToken,
            },
          }
        )
      } catch (error) {
        return {
          kind: "unknown",
          reason:
            error instanceof SandboxProviderError
              ? error.category
              : "browser_media_contract_unverified",
        }
      }
    },
    read,
    async stop(sessionId, signal) {
      // A direct caller cannot skip ownership verification. No cached first-session binding.
      const observation = await read(sessionId, signal)
      if (observation.kind !== "session")
        throw new SandboxProviderError(
          observation.kind === "unknown" ? "http_unknown" : observation.kind
        )
      if (observation.state === "stopped") return
      await request(
        "DELETE",
        sessionPath(sessionId),
        privateApiKey,
        signal,
        async (response, value) => {
          if (response.status === 401 || response.status === 403)
            throw new SandboxProviderError("forbidden")
          if (response.status === 404)
            throw new SandboxProviderError("not_found")
          if (response.status !== 200)
            throw new SandboxProviderError("http_unknown")
          if (
            !object(value) ||
            value.session_id !== sessionId ||
            value.status !== "terminated"
          )
            throw new SandboxProviderError("malformed_response")
          // Acknowledged request only. Lifecycle must independently GET terminal proof.
        }
      )
    },
  }
}
