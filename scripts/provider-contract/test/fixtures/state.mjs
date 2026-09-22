import { safeRef } from "../../run.mjs"

export const identity = {
  runId: "run-canary-private",
  organization: "org-canary-private",
  sessionId: "session-canary-private",
  buildId: "build-canary-private",
  deploymentId: "deployment-canary-private",
  bootId: "boot-canary-private",
  secret: Buffer.alloc(32, 7),
  caseId: "cold_start",
  path: "/callback",
}
export const production = {
  manifest: {
    agentName: "duplexd-agent",
    buildId: "3010f496-fd84-4f39-a75c-c4a58a1bd922",
    imageDigest:
      "sha256:032aa1f121bc91a22748c725966bfd21e6659daaf8b159d367fd6e0f7a745242",
    minAgents: 0,
    maxAgents: 3,
    secretSets: ["duplexd-agent-secrets"],
  },
  sessions: [],
  keys: { body: { private: [] } },
  secretSets: { body: { sets: [] } },
}
export const active = {
  status: "running",
  startedAt: "2026-09-22T00:00:00.000Z",
  endedAt: null,
}
export const ended = {
  ...active,
  status: "ended",
  endedAt: "2026-09-22T00:01:00.000Z",
  updatedAt: "2026-09-22T00:01:01.000Z",
  resourceMetrics: { sampleCount: 2, timeseries: [{ t: 1 }, { t: 2 }] },
}

export async function seed(
  store,
  {
    session = true,
    outcome = "accepted",
    deadline = Date.now() + 720_000,
    sources = ["application_registration"],
  } = {}
) {
  const sessionRef = safeRef(store.recovery.salt, identity.sessionId)
  await store.checkpoint((recovery) => {
    recovery.probe = {
      buildId: identity.buildId,
      deploymentId: identity.deploymentId,
    }
    recovery.starts = 1
    recovery.dispatches = [
      {
        dispatchRef: "dispatch-ref",
        caseRef: identity.caseId,
        dispatchedAt: deadline - 720_000,
        deadline,
        providerDeadline: deadline - 120_000,
        outcome,
      },
    ]
    if (session)
      recovery.sessions[sessionRef] = {
        id: identity.sessionId,
        caseRef: identity.caseId,
        sources,
        stopAttempts: 0,
        stopHistory: [],
        deadline,
        terminal: false,
        confirmedBilledMinutes: null,
        usageStatus: "unknown",
      }
  })
  await store.append({
    kind: "operation_intent",
    source: "application",
    caseRef: identity.caseId,
    operationRef: "dispatch-ref",
    payload: {
      name: "start_session",
      deadline: new Date(deadline).toISOString(),
    },
  })
  return sessionRef
}

export function dependencies(store, overrides = {}) {
  let now = Date.now()
  let absent = false
  const calls = []
  const deps = {
    now: () => now,
    sleep: async (ms) => {
      calls.push(["sleep", ms])
      now += ms
    },
    readProbe: async () => {
      calls.push(["readProbe"])
      if (absent) throw new Error("provider_http_404")
      return {
        manifest: {
          agentName: store.recovery.serviceName,
          ...store.recovery.probe,
        },
        sessions: [],
      }
    },
    readProduction: async () => {
      calls.push(["readProduction"])
      return structuredClone(production)
    },
    readSession: async (id) => {
      calls.push(["readSession", id, now])
      return ended
    },
    stopSession: async (id) => {
      calls.push(["stopSession", id, now])
      return { status: "success", exitCode: 0, httpStatus: null }
    },
    deleteProbe: async () => {
      calls.push(["deleteProbe"])
      absent = true
      return { status: "success", exitCode: 0, httpStatus: null }
    },
    probeAbsent: async () => {
      calls.push(["probeAbsent"])
      return absent
    },
    startSession: async () => {
      calls.push(["startSession"])
      throw new Error("recovery_must_never_start")
    },
    ...overrides,
  }
  return { deps, calls }
}
