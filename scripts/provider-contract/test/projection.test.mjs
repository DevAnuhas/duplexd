import assert from "node:assert/strict"
import { test } from "node:test"
import { projectSummary } from "../run.mjs"
import { completeEvidence } from "./fixtures/projection.mjs"

test("complete synthetic six-case resource proof can pass with separate unknown accounting", () => {
  const { records, recovery } = completeEvidence()
  const summary = projectSummary(records, recovery)
  assert.equal(summary.status, "pass")
  assert.equal(summary.resourceStatus, "pass")
  assert.equal(summary.accountingStatus, "unknown")
  assert.equal(summary.confirmedBilledMinutes, null)
  assert.equal(summary.reservedSessionMinutes, 72)
  assert.equal(Object.keys(summary.cases).length, 6)
})

for (const kind of [
  "operation_result",
  "session_identity",
  "callback",
  "witness_observation",
  "session_status",
  "resource_observation",
  "cleanup_result",
])
  test(`six case verdicts cannot substitute for missing ${kind} observations`, () => {
    const { records, recovery } = completeEvidence()
    assert.equal(
      projectSummary(
        records.filter((record) => record.kind !== kind),
        recovery
      ).status,
      "blocked"
    )
  })

for (const mutate of [
  function missingCase(records) {
    return records.filter((record) => record.caseRef !== "cold_start")
  },
  function wrongLostResponse(records) {
    records.find(
      (record) =>
        record.caseRef === "lost_start_response_registered" &&
        record.kind === "operation_result" &&
        record.payload.name === "start_session"
    ).payload.status = "success"
    return records
  },
  function unexpectedRegistration(records) {
    records.push({
      kind: "callback",
      caseRef: "no_registration_startup",
      payload: { event: "registered" },
    })
    return records
  },
  function repeatedSuccess(records) {
    const record = records.find(
      (record) => record.payload.name === "repeat_stop_session"
    )
    record.payload.httpStatus = null
    record.payload.status = "success"
    return records
  },
  function missingBrowserBound(records) {
    records.find(
      (record) => record.payload.browserClaimsBounded
    ).payload.browserClaimsBounded = false
    return records
  },
  function failedCleanup(records) {
    records.find(
      (record) => record.payload.check === "production_unchanged"
    ).payload.status = "failed"
    return records
  },
  function missingResourceSamples(records) {
    records.find(
      (record) => record.payload.resource === "session_resources"
    ).payload.metricSampleCount = null
    return records
  },
  function unboundedAgentClaims(records) {
    records.find(
      (record) =>
        record.kind === "callback" && record.payload.event === "agent_joined"
    ).payload.dailyClaimsBounded = false
    return records
  },
  function wrongSessionTerminal(records) {
    records.find(
      (record) => record.kind === "session_status"
    ).payload.sessionRef = "unrelated-session"
    return records
  },
])
  test(`required observations fail closed: ${mutate.name}`, () => {
    const { records, recovery } = completeEvidence()
    assert.equal(projectSummary(mutate(records), recovery).status, "blocked")
  })

test("summary cannot reset first failure or ignore an ambiguous dispatch or truncated journal", () => {
  const { records, recovery } = completeEvidence()
  assert.equal(projectSummary(records, recovery, true).status, "blocked")
  recovery.dispatches[0].outcome = "unknown"
  assert.equal(projectSummary(records, recovery).status, "blocked")
  recovery.dispatches[0].outcome = "accepted"
  records.push({
    kind: "first_failure",
    payload: { category: "operator_signal" },
  })
  assert.equal(projectSummary(records, recovery).status, "blocked")
})

for (const corrupt of [
  function missingScopedZero(recovery) {
    delete recovery.cleanup.zeroActiveComplete
  },
  function failedScopedZero(recovery) {
    recovery.cleanup.zeroActiveComplete = false
  },
  function invalidatedReadback(recovery) {
    Object.values(recovery.sessions)[0].readbackValid = false
  },
  function activeCheckpoint(recovery) {
    Object.values(recovery.sessions)[0].terminal = false
  },
  function unresolvedAcceptedDispatch(recovery) {
    delete recovery.sessions[Object.keys(recovery.sessions)[0]]
  },
])
  test(`pass-shaped journal cannot override current checkpoint: ${corrupt.name}`, () => {
    const { records, recovery } = completeEvidence()
    assert.equal(projectSummary(records, recovery).resourceStatus, "pass")
    corrupt(recovery)
    const summary = projectSummary(records, recovery)
    assert.equal(summary.status, "blocked")
    assert.equal(summary.resourceStatus, "blocked")
    assert.equal(summary.accountingStatus, "unknown")
    assert.equal(summary.confirmedBilledMinutes, null)
  })
