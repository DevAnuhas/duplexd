import { CASES, normalizeSessionObservation } from "../../run.mjs"
import { ended } from "./state.mjs"

// Synthetic contract evidence, never provider proof. Exercise the projection's
// positive branch, then remove/corrupt one observation at a time in tests.
export function completeEvidence() {
  const records = []
  const recovery = {
    salt: "synthetic-salt",
    runId: "synthetic-run",
    starts: 6,
    reservedSessionMinutes: 72,
    dispatches: [],
    sessions: {},
    cleanup: {
      completed: true,
      zeroActiveComplete: true,
      probeServiceAbsent: true,
      productionUnchanged: true,
      unresolvedSessions: 0,
    },
  }
  const append = (caseRef, kind, source, payload) =>
    records.push({
      schemaVersion: 1,
      sequence: records.length + 1,
      receivedAt: "2026-09-22T00:00:00.000Z",
      elapsedMs: records.length,
      runRef: "run-ref",
      caseRef,
      operationRef: null,
      kind,
      source,
      payload,
    })
  for (const definition of CASES) {
    const { id } = definition
    const sessionRef = `${id}-session-ref`
    recovery.sessions[sessionRef] = {
      id: `private-${id}`,
      caseRef: id,
      ...normalizeSessionObservation(ended),
    }
    recovery.dispatches.push({
      caseRef: id,
      outcome: "accepted",
      reservedMinutes: 12,
    })
    append(id, "operation_intent", "application", { name: "start_session" })
    append(id, "operation_result", "application", {
      name: "start_session",
      status: definition.discard ? "lost_response" : "success",
      browserClaimsBounded: true,
      sessionRef: definition.discard ? null : sessionRef,
    })
    append(id, "session_identity", "operator_start_response", {
      sessionRef,
      applicationVisible: !definition.discard,
    })
    if (id !== "no_registration_startup") {
      append(id, "session_identity", "application_registration", { sessionRef })
      append(id, "callback", "authenticated_probe", {
        event: "registered",
        sessionRef,
        dailyClaimsBounded: true,
      })
    }
    if (definition.join) {
      append(id, "callback", "authenticated_probe", {
        event: "agent_joined",
        sessionRef,
        dailyClaimsBounded: true,
      })
      append(id, "witness_observation", "operator_witness", {
        event: "browser_joined",
      })
    }
    if (definition.stop === "ceiling") {
      append(id, "callback", "authenticated_probe", {
        event: "agent_ejected",
        sessionRef,
        dailyClaimsBounded: true,
      })
      append(id, "witness_observation", "operator_witness", {
        event: "browser_ejected",
      })
    } else {
      append(id, "operation_result", "application_recovery", {
        name: "stop_session",
        targetRef: sessionRef,
        status: "success",
        httpStatus: 200,
      })
    }
    if (definition.stop === "twice")
      append(id, "operation_result", "operator", {
        name: "repeat_stop_session",
        targetRef: sessionRef,
        status: "http_error",
        httpStatus: 404,
        exitCode: 1,
      })
    append(id, "session_status", "provider_readback", {
      sessionRef,
      terminal: true,
      state: "ended",
      httpStatus: 200,
      providerEndedAt: "2026-09-22T00:01:00.000Z",
    })
    append(id, "resource_observation", "provider_readback", {
      resource: "session_resources",
      sessionRef,
      ...normalizeSessionObservation(ended),
    })
    append(id, "resource_observation", "private_session_readback", {
      resource: "probe_sessions",
      complete: true,
      activeSessionCount: 0,
      httpStatus: 200,
    })
    append(id, "verdict", "operator", { status: "pass" })
  }
  for (const check of [
    "probe_service_absent",
    "production_unchanged",
    "containment",
  ])
    append(null, "cleanup_result", "provider_readback", {
      check,
      status: "confirmed",
    })
  append(null, "verdict", "operator", { status: "pass" })
  return { records, recovery }
}
