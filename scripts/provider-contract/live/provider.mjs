const ORIGIN = "https://api.pipecat.daily.co"
const AGENT = "duplexd-agent"

function requireCredential(value, name) {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${name} is required`)
  return value.trim()
}

function requiredString(record, keys, label = keys[0]) {
  for (const key of keys) {
    const value = record?.[key]
    if (typeof value === "string" && value.length > 0) return value
  }
  throw new Error(`Pipecat response omitted ${label}`)
}

function requiredNumber(record, keys, label = keys[0]) {
  for (const key of keys) {
    const value = record?.[key]
    if (Number.isFinite(value)) return value
  }
  throw new Error(`Pipecat response omitted ${label}`)
}

async function requestJson(
  url,
  {
    credential,
    method = "GET",
    body,
    timeoutMs = 15_000,
    fetchImpl = fetch,
    accepted = [200],
  }
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
    // Provider error bodies and credentials are never retained in errors.
  }
  if (!accepted.includes(response.status)) {
    throw new Error(`Pipecat ${method} returned HTTP ${response.status}`)
  }
  return { status: response.status, value }
}

function serviceBody(value) {
  const source = value?.body ?? value?.service ?? value
  if (source === null || typeof source !== "object") {
    throw new Error("Pipecat service response is invalid")
  }
  return source
}

function digestFromImage(value) {
  if (typeof value !== "string") return undefined
  const match = value.match(/@(sha256:[a-f0-9]{64})$/iu)
  return match?.[1]
}

export function normalizeManifest(value) {
  const source = serviceBody(value)
  const deployment =
    source.activeDeployment ??
    source.deployment ??
    source.latestDeployment ??
    source
  const scaling = deployment.autoScaling ?? source.autoScaling ?? deployment
  const build = deployment.build ?? source.build ?? deployment
  const image =
    build.image !== null && typeof build.image === "object"
      ? build.image
      : build
  const manifestImage = deployment.manifest?.spec?.image
  const imageDigest =
    deployment.imageDigest ??
    source.imageDigest ??
    image.imageDigest ??
    image.digest ??
    digestFromImage(manifestImage)
  const secretSet =
    deployment.secretSet ??
    deployment.secretSetName ??
    source.secretSet ??
    source.secretSetName
  const manifest = {
    agentName: requiredString(source, ["serviceName", "name"], "agent name"),
    deploymentId: requiredString(
      {
        deploymentId:
          deployment.deploymentId ?? deployment.id ?? source.activeDeploymentId,
      },
      ["deploymentId"],
      "deployment ID"
    ),
    buildId: requiredString(
      {
        buildId:
          build.buildId ?? build.id ?? deployment.buildId ?? source.buildId,
      },
      ["buildId"],
      "build ID"
    ),
    imageDigest: requiredString(
      { imageDigest },
      ["imageDigest"],
      "image digest"
    ),
    minAgents: requiredNumber(
      scaling,
      ["minAgents", "minReplicas"],
      "minimum agents"
    ),
    maxAgents: requiredNumber(
      scaling,
      ["maxAgents", "maxReplicas"],
      "maximum agents"
    ),
    secretSet: requiredString(
      { secretSet },
      ["secretSet"],
      "secret-set reference"
    ),
  }
  const duration =
    deployment.maxSessionDurationSeconds ??
    deployment.maxSessionDuration ??
    source.maxSessionDurationSeconds ??
    source.maxSessionDuration
  if (duration !== undefined && duration !== null)
    manifest.maxSessionDurationSeconds = duration
  return manifest
}

export function normalizeSession(value, expectedSessionId) {
  const source = value?.body ?? value?.session ?? value
  const sessionId = requiredString(source, ["sessionId", "id"], "session ID")
  if (expectedSessionId !== undefined && sessionId !== expectedSessionId) {
    throw new Error("Pipecat session response does not match requested session")
  }
  const createdAt = requiredString(
    source,
    ["createdAt"],
    "session creation time"
  )
  const endedAt = source.endedAt
  if (endedAt !== null && typeof endedAt !== "string") {
    throw new Error("Pipecat session endedAt is invalid")
  }
  const createdMillis = Date.parse(createdAt)
  const endedMillis = endedAt === null ? null : Date.parse(endedAt)
  if (
    !Number.isFinite(createdMillis) ||
    (endedMillis !== null && !Number.isFinite(endedMillis))
  ) {
    throw new Error("Pipecat session timestamps are invalid")
  }
  if (endedMillis !== null && endedMillis < createdMillis) {
    throw new Error("Pipecat session ended before it was created")
  }
  return {
    sessionId,
    deploymentId: requiredString(
      source,
      ["deploymentId"],
      "session deployment ID"
    ),
    createdAt,
    endedAt,
    updatedAt: requiredString(source, ["updatedAt"], "session update time"),
    completionStatus:
      source.completionStatus === null ||
      typeof source.completionStatus === "string"
        ? source.completionStatus
        : null,
    resourceMetrics:
      source.resourceMetrics !== null &&
      typeof source.resourceMetrics === "object"
        ? source.resourceMetrics
        : null,
    billedMinutes:
      endedMillis === null ? null : (endedMillis - createdMillis) / 60_000,
  }
}

export class ProviderClient {
  constructor({ publicKey, privateKey, fetchImpl = fetch }) {
    this.publicKey = requireCredential(publicKey, "public start key")
    this.privateKey = requireCredential(privateKey, "private management key")
    this.fetchImpl = fetchImpl
  }

  async start({ body, expiresAtEpochSeconds }) {
    const { value } = await requestJson(`${ORIGIN}/v1/public/${AGENT}/start`, {
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
    return {
      sessionId: requiredString(value, ["sessionId"]),
      dailyRoom: requiredString(value, ["dailyRoom"]),
      dailyToken: requiredString(value, ["dailyToken"]),
    }
  }

  async stop(sessionId) {
    return requestJson(
      `${ORIGIN}/v1/agents/${AGENT}/sessions/${encodeURIComponent(sessionId)}`,
      {
        credential: this.privateKey,
        method: "DELETE",
        fetchImpl: this.fetchImpl,
        accepted: [200, 404],
      }
    )
  }

  async sessions(status = "all") {
    const url = new URL(`${ORIGIN}/v1/agents/${AGENT}/sessions`)
    url.searchParams.set("status", status)
    url.searchParams.set("limit", "100")
    const { value } = await requestJson(url, {
      credential: this.privateKey,
      fetchImpl: this.fetchImpl,
    })
    if (!Array.isArray(value?.sessions))
      throw new Error("Pipecat sessions response is invalid")
    return value.sessions.map((session) => normalizeSession(session))
  }

  async session(sessionId) {
    const { value } = await requestJson(
      `${ORIGIN}/v1/agents/${AGENT}/sessions/${encodeURIComponent(sessionId)}`,
      { credential: this.privateKey, fetchImpl: this.fetchImpl }
    )
    return normalizeSession(value, sessionId)
  }

  async readManifest() {
    const { value } = await requestJson(`${ORIGIN}/v1/agents/${AGENT}`, {
      credential: this.privateKey,
      fetchImpl: this.fetchImpl,
    })
    return normalizeManifest(value)
  }

  async setMaxSessionDuration(seconds) {
    if (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > 14_400) {
      throw new Error(
        "Pipecat duration must be an integer from 60 through 14400"
      )
    }
    const { value } = await requestJson(`${ORIGIN}/v1/agents/${AGENT}`, {
      credential: this.privateKey,
      method: "POST",
      body: { maxSessionDuration: seconds },
      timeoutMs: 30_000,
      fetchImpl: this.fetchImpl,
    })
    return value
  }
}

export class ControlPlaneClient {
  constructor({ operatorToken, organization, fetchImpl = fetch }) {
    this.operatorToken = requireCredential(operatorToken, "operator token")
    this.organization = requireCredential(organization, "organization")
    this.fetchImpl = fetchImpl
  }

  #url(path) {
    return `${ORIGIN}/v1/organizations/${encodeURIComponent(this.organization)}${path}`
  }

  async readManifest() {
    const { value } = await requestJson(this.#url(`/services/${AGENT}`), {
      credential: this.operatorToken,
      fetchImpl: this.fetchImpl,
    })
    return normalizeManifest(value)
  }

  async listSessions() {
    const { value } = await requestJson(
      this.#url(`/services/${AGENT}/sessions`),
      {
        credential: this.operatorToken,
        fetchImpl: this.fetchImpl,
      }
    )
    const sessions = value?.sessions ?? value
    if (!Array.isArray(sessions))
      throw new Error("Pipecat session-list response is invalid")
    return sessions.map((session) => normalizeSession(session))
  }

  async createPrivateKey(name) {
    const { value } = await requestJson(this.#url("/apiKeys"), {
      credential: this.operatorToken,
      method: "POST",
      body: { name, type: "private" },
      fetchImpl: this.fetchImpl,
      accepted: [200, 201],
    })
    const created = value?.body?.apiKey ?? value?.body ?? value?.apiKey ?? value
    return {
      id: requiredString(created, ["id", "apiKeyId"], "API key ID"),
      key: requiredString(
        created,
        ["key", "apiKey", "token"],
        "private API key"
      ),
      name: requiredString(created, ["name"], "API key name"),
      type: requiredString(created, ["type"], "API key type"),
    }
  }

  async listKeys() {
    const { value } = await requestJson(this.#url("/apiKeys"), {
      credential: this.operatorToken,
      fetchImpl: this.fetchImpl,
    })
    const root = value?.body ?? value
    const keys = root?.apiKeys ?? root?.keys
    if (!Array.isArray(keys))
      throw new Error("Pipecat API-key response is invalid")
    return keys.map((key) => ({
      id: requiredString(key, ["id", "apiKeyId"], "API key ID"),
      name: requiredString(key, ["name"], "API key name"),
      type: requiredString(key, ["type"], "API key type"),
    }))
  }

  async revokeKey(keyId) {
    await requestJson(this.#url(`/apiKeys/${encodeURIComponent(keyId)}`), {
      credential: this.operatorToken,
      method: "DELETE",
      fetchImpl: this.fetchImpl,
      accepted: [200, 204, 404],
    })
  }

  async createProbeSecretSet(values) {
    const required = [
      "PROVIDER_CONTRACT_PROBE_ENABLED",
      "PROVIDER_CONTRACT_PROBE_RUN_ID",
      "PROVIDER_CONTRACT_PROBE_CALLBACK_URL",
      "PROVIDER_CONTRACT_PROBE_ACTIVATION_SECRET",
    ]
    if (
      Object.keys(values).length !== required.length ||
      required.some(
        (key) => typeof values[key] !== "string" || values[key].length === 0
      )
    ) {
      throw new Error(
        "temporary probe secret set must contain four exact values"
      )
    }
    for (const secretKey of required) {
      await requestJson(this.#url("/secrets/duplexd-provider-proof"), {
        credential: this.operatorToken,
        method: "PUT",
        body: {
          name: "duplexd-provider-proof",
          isImagePullSecret: false,
          secretKey,
          secretValue: values[secretKey],
        },
        fetchImpl: this.fetchImpl,
        accepted: [200, 201],
      })
    }
  }

  async listSecretSets() {
    const { value } = await requestJson(this.#url("/secrets"), {
      credential: this.operatorToken,
      fetchImpl: this.fetchImpl,
    })
    const root = value?.body ?? value
    if (!Array.isArray(root?.sets))
      throw new Error("Pipecat secret-set response is invalid")
    return root.sets.map((set) => ({
      name: requiredString(set, ["name"], "secret-set name"),
      type: requiredString(set, ["type"], "secret-set type"),
    }))
  }

  async deleteProbeSecretSet() {
    await requestJson(this.#url("/secrets/duplexd-provider-proof"), {
      credential: this.operatorToken,
      method: "DELETE",
      fetchImpl: this.fetchImpl,
      accepted: [200, 204, 404],
    })
  }

  async restoreBaseline({ buildId, secretSet, minAgents, maxAgents }) {
    const { value } = await requestJson(this.#url("/services"), {
      credential: this.operatorToken,
      method: "PUT",
      body: {
        serviceName: AGENT,
        buildId,
        secretSet,
        autoScaling: { minAgents, maxAgents },
        agentProfile: "agent-1x",
      },
      timeoutMs: 60_000,
      fetchImpl: this.fetchImpl,
      accepted: [200, 201],
    })
    return value
  }
}
