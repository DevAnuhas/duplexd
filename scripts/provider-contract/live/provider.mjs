const ORIGIN = "https://api.pipecat.daily.co"
const AGENT = "duplexd-agent"

function requireCredential(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required`)
  }
  return value.trim()
}

async function requestJson(
  url,
  { credential, method = "GET", body, timeoutMs = 15_000, fetchImpl = fetch }
) {
  let response
  try {
    response = await fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${credential}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    throw new Error(`Pipecat ${method} request failed`, { cause: null })
  }
  let value = null
  try {
    value = await response.json()
  } catch {
    // Status and endpoint are safe; provider error bodies are not retained.
  }
  return { status: response.status, value }
}

function requiredString(record, key) {
  const value = record?.[key]
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Pipecat response omitted ${key}`)
  }
  return value
}

export class ProviderClient {
  constructor({ publicKey, privateKey, fetchImpl = fetch }) {
    this.publicKey = requireCredential(publicKey, "public start key")
    this.privateKey = requireCredential(privateKey, "private management key")
    this.fetchImpl = fetchImpl
  }

  async start({ body, expiresAtEpochSeconds }) {
    const response = await requestJson(`${ORIGIN}/v1/public/${AGENT}/start`, {
      credential: this.publicKey,
      method: "POST",
      body: {
        createDailyRoom: true,
        transport: "daily",
        dailyRoomProperties: {
          exp: expiresAtEpochSeconds,
          eject_at_room_exp: true,
        },
        dailyMeetingTokenProperties: {
          exp: expiresAtEpochSeconds,
          eject_at_token_exp: true,
          is_owner: false,
        },
        body,
      },
      fetchImpl: this.fetchImpl,
    })
    if (response.status !== 200 || response.value === null) {
      throw new Error(`Pipecat start returned HTTP ${response.status}`)
    }
    return {
      sessionId: requiredString(response.value, "sessionId"),
      dailyRoom: requiredString(response.value, "dailyRoom"),
      dailyToken: requiredString(response.value, "dailyToken"),
    }
  }

  async stop(sessionId) {
    const response = await requestJson(
      `${ORIGIN}/v1/agents/${AGENT}/sessions/${encodeURIComponent(sessionId)}`,
      {
        credential: this.privateKey,
        method: "DELETE",
        fetchImpl: this.fetchImpl,
      }
    )
    if (response.status !== 200 && response.status !== 404) {
      throw new Error(`Pipecat stop returned HTTP ${response.status}`)
    }
    return { status: response.status, value: response.value }
  }

  async sessions(status = "all") {
    const url = new URL(`${ORIGIN}/v1/agents/${AGENT}/sessions`)
    url.searchParams.set("status", status)
    url.searchParams.set("limit", "100")
    const response = await requestJson(url, {
      credential: this.privateKey,
      fetchImpl: this.fetchImpl,
    })
    if (response.status !== 200 || !Array.isArray(response.value?.sessions)) {
      throw new Error(`Pipecat sessions returned HTTP ${response.status}`)
    }
    return response.value.sessions
  }

  async setMaxSessionDuration(seconds) {
    const response = await requestJson(`${ORIGIN}/v1/agents/${AGENT}`, {
      credential: this.privateKey,
      method: "POST",
      body: { maxSessionDuration: seconds },
      timeoutMs: 30_000,
      fetchImpl: this.fetchImpl,
    })
    if (response.status !== 200) {
      throw new Error(
        `Pipecat duration update returned HTTP ${response.status}`
      )
    }
    return response.value
  }
}
