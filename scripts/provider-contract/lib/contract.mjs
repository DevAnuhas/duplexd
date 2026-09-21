import { createHash } from "node:crypto"

export const CASES = Object.freeze([
  "cold_start",
  "cancel_before_join",
  "lost_start_response_registered",
  "no_registration_startup",
  "hung_runtime",
  "known_session_stop_retry",
])

export const REQUIRED_LIMITS = Object.freeze({
  startupSeconds: 120,
  providerMaxSessionSeconds: 600,
  operatorContainmentSeconds: 720,
})

const SAFE_REF = /^sha256:[a-f0-9]{64}$/u
const RAW_UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu
const SECRET_KEY =
  /(?:authorization|api[_-]?key|secret|raw[_-]?token|private[_-]?key)/iu
const TOKEN_VALUE =
  /(?:^Bearer\s+|^pk_[A-Za-z0-9]|^sk_[A-Za-z0-9]|^[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}$)/u

const REQUIRED_CASE_CHECKS = Object.freeze({
  cold_start: ["startResponseFields", "registrationMatched"],
  cancel_before_join: [
    "knownSessionStopTargetStable",
    "processTerminated",
    "usageCeased",
  ],
  lost_start_response_registered: [
    "registrationMatched",
    "knownSessionStopTargetStable",
    "processTerminated",
    "usageCeased",
  ],
  no_registration_startup: [
    "providerExecutionCeilingObserved",
    "browserEjected",
    "agentEjected",
    "processTerminated",
    "usageCeased",
  ],
  hung_runtime: [
    "providerExecutionCeilingObserved",
    "browserEjected",
    "agentEjected",
    "processTerminated",
    "usageCeased",
  ],
  known_session_stop_retry: [
    "knownSessionStopTargetStable",
    "stop404Reconciled",
    "processTerminated",
    "usageCeased",
  ],
})

const REQUIRED_OBSERVATION_SOURCES = Object.freeze({
  startResponseFields: ["start_response"],
  registrationMatched: ["runner_registration"],
  knownSessionStopTargetStable: ["stop_response"],
  stop404Reconciled: ["provider_session_status"],
  providerExecutionCeilingObserved: ["provider_session_status"],
  browserEjected: ["daily_browser_event"],
  agentEjected: ["daily_agent_event"],
  processTerminated: ["provider_session_status"],
  usageCeased: ["provider_usage"],
})

export function safeReference(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("A non-empty reference is required.")
  }

  return `sha256:${createHash("sha256").update(value).digest("hex")}`
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function parseTime(value, path, errors) {
  if (typeof value !== "string") {
    errors.push(`${path} must be an ISO timestamp.`)
    return null
  }

  const milliseconds = Date.parse(value)
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    errors.push(`${path} must be a canonical ISO timestamp.`)
    return null
  }

  return milliseconds
}

function assertBoolean(record, key, path, errors) {
  if (record[key] !== true) {
    errors.push(`${path}.${key} must be true.`)
  }
}

function scanForSecrets(value, path, errors) {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      scanForSecrets(item, `${path}[${index}]`, errors)
    )
    return
  }

  if (!isRecord(value)) {
    if (typeof value === "string") {
      if (RAW_UUID.test(value) && /(?:sessionRef|callRef)$/u.test(path)) {
        errors.push(`${path} contains a raw UUID; use safeReference().`)
      }
      if (TOKEN_VALUE.test(value)) {
        errors.push(`${path} appears to contain a credential or raw token.`)
      }
    }
    return
  }

  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`
    if (SECRET_KEY.test(key) && typeof child === "string" && child.length > 0) {
      errors.push(`${childPath} must not retain a credential value.`)
    }
    scanForSecrets(child, childPath, errors)
  }
}

function validateSourceFacts(sourceFacts, errors) {
  if (!Array.isArray(sourceFacts) || sourceFacts.length === 0) {
    errors.push("evidence.sourceFacts must contain documented facts.")
    return
  }

  sourceFacts.forEach((fact, index) => {
    const path = `evidence.sourceFacts[${index}]`
    if (!isRecord(fact)) {
      errors.push(`${path} must be an object.`)
      return
    }
    if (fact.kind !== "documented") {
      errors.push(`${path}.kind must be documented.`)
    }
    if (typeof fact.claim !== "string" || fact.claim.trim() === "") {
      errors.push(`${path}.claim is required.`)
    }
    if (
      typeof fact.source !== "string" ||
      !fact.source.startsWith("https://")
    ) {
      errors.push(`${path}.source must be an HTTPS URL.`)
    }
    parseTime(fact.checkedAt, `${path}.checkedAt`, errors)
  })
}

function validateMedia(media, deadlineMilliseconds, sessionRef, path, errors) {
  if (!isRecord(media)) {
    errors.push(`${path} must be an object.`)
    return
  }

  if (media.sessionRef !== sessionRef) {
    errors.push(`${path}.sessionRef must match the containing case.`)
  }

  for (const participant of ["room", "browser", "agent"]) {
    const value = media[participant]
    const participantPath = `${path}.${participant}`
    if (!isRecord(value)) {
      errors.push(`${participantPath} must be an object.`)
      continue
    }

    const expiry = parseTime(
      value.expiresAt,
      `${participantPath}.expiresAt`,
      errors
    )
    if (
      expiry !== null &&
      deadlineMilliseconds !== null &&
      expiry > deadlineMilliseconds
    ) {
      errors.push(
        `${participantPath}.expiresAt exceeds the operator-containment deadline.`
      )
    }
    parseTime(value.observedAt, `${participantPath}.observedAt`, errors)
    assertBoolean(value, "ejectAtExpiry", participantPath, errors)
  }

  const browser = media.browser
  if (isRecord(browser)) {
    if (browser.isOwner !== false) {
      errors.push(`${path}.browser.isOwner must be false.`)
    }
    assertBoolean(browser, "roomScoped", `${path}.browser`, errors)
  }

  if (isRecord(media.agent)) {
    assertBoolean(media.agent, "roomScoped", `${path}.agent`, errors)
  }
}

function validateStopAttempts(testCase, path, errors) {
  const requiresStop = testCase.checks?.knownSessionStopTargetStable === true
  if (
    !Array.isArray(testCase.stopAttempts) ||
    testCase.stopAttempts.length === 0
  ) {
    if (requiresStop) {
      errors.push(
        `${path}.stopAttempts must contain exact-session cleanup evidence.`
      )
    }
    return
  }

  const refs = new Set()
  let saw404 = false
  for (const [index, attempt] of testCase.stopAttempts.entries()) {
    const attemptPath = `${path}.stopAttempts[${index}]`
    if (!isRecord(attempt)) {
      errors.push(`${attemptPath} must be an object.`)
      continue
    }
    if (
      typeof attempt.sessionRef !== "string" ||
      !SAFE_REF.test(attempt.sessionRef)
    ) {
      errors.push(`${attemptPath}.sessionRef must be a safe SHA-256 reference.`)
    } else {
      refs.add(attempt.sessionRef)
      if (attempt.sessionRef !== testCase.sessionRef) {
        errors.push(`${attemptPath}.sessionRef must match the containing case.`)
      }
    }
    if (!Number.isInteger(attempt.httpStatus)) {
      errors.push(`${attemptPath}.httpStatus must be an integer.`)
    }
    if (attempt.httpStatus === 404) {
      saw404 = true
    }
  }

  if (refs.size > 1) {
    errors.push(
      `${path}.stopAttempts must always target the same known session.`
    )
  }
  if (saw404 && testCase.checks?.stop404Reconciled !== true) {
    errors.push(
      `${path} treats a 404 as final without identity/status reconciliation.`
    )
  }
  if (testCase.case === "known_session_stop_retry") {
    if (testCase.stopAttempts.length < 2) {
      errors.push(`${path}.stopAttempts must demonstrate a retry.`)
    }
    if (!saw404) {
      errors.push(`${path}.stopAttempts must include a reconciled 404.`)
    }
  }
}

function validateCaseObservations(testCase, path, mode, errors) {
  if (
    !Array.isArray(testCase.observations) ||
    testCase.observations.length === 0
  ) {
    errors.push(`${path}.observations must contain timestamped evidence.`)
    return
  }

  const sources = new Set()
  testCase.observations.forEach((observation, index) => {
    const observationPath = `${path}.observations[${index}]`
    if (!isRecord(observation)) {
      errors.push(`${observationPath} must be an object.`)
      return
    }
    if (observation.kind !== mode) {
      errors.push(
        `${observationPath}.kind must match evidence.observationMode.`
      )
    }
    if (typeof observation.source !== "string" || observation.source === "") {
      errors.push(`${observationPath}.source is required.`)
    } else {
      sources.add(observation.source)
    }
    if (observation.sessionRef !== testCase.sessionRef) {
      errors.push(
        `${observationPath}.sessionRef must match the containing case.`
      )
    }
    if (
      typeof observation.fact !== "string" ||
      observation.fact.trim() === ""
    ) {
      errors.push(`${observationPath}.fact is required.`)
    }
    parseTime(observation.observedAt, `${observationPath}.observedAt`, errors)
  })

  if (isRecord(testCase.checks)) {
    for (const [check, requiredSources] of Object.entries(
      REQUIRED_OBSERVATION_SOURCES
    )) {
      if (testCase.checks[check] !== true) {
        continue
      }
      for (const requiredSource of requiredSources) {
        if (!sources.has(requiredSource)) {
          errors.push(
            `${path}.checks.${check} lacks a ${requiredSource} observation.`
          )
        }
      }
    }
  }
}

function validateCase(testCase, path, mode, limits, errors) {
  if (!isRecord(testCase)) {
    errors.push(`${path} must be an object.`)
    return
  }
  if (!CASES.includes(testCase.case)) {
    errors.push(`${path}.case is not recognized.`)
    return
  }
  if (testCase.observation !== mode) {
    errors.push(`${path}.observation must match evidence.observationMode.`)
  }
  if (
    typeof testCase.injection !== "string" ||
    testCase.injection.trim() === ""
  ) {
    errors.push(`${path}.injection must state the injected fault.`)
  }
  if (
    typeof testCase.cessationBoundary !== "string" ||
    testCase.cessationBoundary === ""
  ) {
    errors.push(
      `${path}.cessationBoundary must state the observed stopping boundary.`
    )
  }
  if (testCase.cessationBoundary === "room_ejection") {
    errors.push(
      `${path}.cessationBoundary cannot use room ejection as process/usage proof.`
    )
  }
  if (
    typeof testCase.sessionRef !== "string" ||
    !SAFE_REF.test(testCase.sessionRef)
  ) {
    errors.push(`${path}.sessionRef must be a safe SHA-256 reference.`)
  }
  if (
    typeof testCase.callRef !== "string" ||
    !SAFE_REF.test(testCase.callRef)
  ) {
    errors.push(`${path}.callRef must be a safe SHA-256 reference.`)
  }

  const dispatched = parseTime(
    testCase.dispatchedAt,
    `${path}.dispatchedAt`,
    errors
  )
  const ceased = parseTime(testCase.ceasedAt, `${path}.ceasedAt`, errors)
  if (dispatched !== null && ceased !== null) {
    if (ceased < dispatched) {
      errors.push(`${path}.ceasedAt precedes dispatch.`)
    } else if (
      ceased - dispatched >
      limits.operatorContainmentSeconds * 1_000
    ) {
      errors.push(`${path} exceeded the operator-containment bound.`)
    }
  }

  const deadline =
    dispatched === null
      ? null
      : dispatched + limits.operatorContainmentSeconds * 1_000
  validateMedia(
    testCase.media,
    deadline,
    testCase.sessionRef,
    `${path}.media`,
    errors
  )

  if (testCase.case === "cold_start") {
    const ready = parseTime(testCase.readyAt, `${path}.readyAt`, errors)
    if (
      dispatched !== null &&
      ready !== null &&
      ready - dispatched > limits.startupSeconds * 1_000
    ) {
      errors.push(`${path} exceeded the startup bound.`)
    }
  }

  if (!isRecord(testCase.checks)) {
    errors.push(`${path}.checks must be an object.`)
  } else {
    for (const check of REQUIRED_CASE_CHECKS[testCase.case]) {
      assertBoolean(testCase.checks, check, `${path}.checks`, errors)
    }
  }

  validateCaseObservations(testCase, path, mode, errors)
  validateStopAttempts(testCase, path, errors)
}

export function validateEvidence(evidence) {
  const errors = []
  const warnings = []

  if (!isRecord(evidence)) {
    return {
      ok: false,
      verdict: "invalid",
      errors: ["Evidence must be a JSON object."],
      warnings,
    }
  }

  scanForSecrets(evidence, "evidence", errors)

  if (evidence.schemaVersion !== 1) {
    errors.push("evidence.schemaVersion must be 1.")
  }
  if (
    evidence.observationMode !== "synthetic" &&
    evidence.observationMode !== "live"
  ) {
    errors.push("evidence.observationMode must be synthetic or live.")
  }
  parseTime(evidence.recordedAt, "evidence.recordedAt", errors)
  validateSourceFacts(evidence.sourceFacts, errors)

  const limits = evidence.limits
  if (!isRecord(limits)) {
    errors.push("evidence.limits must be an object.")
  } else {
    for (const [key, required] of Object.entries(REQUIRED_LIMITS)) {
      if (limits[key] !== required) {
        errors.push(`evidence.limits.${key} must be ${required}.`)
      }
    }
    if (
      !Number.isInteger(limits.providerMaxSessionSeconds) ||
      limits.providerMaxSessionSeconds !==
        REQUIRED_LIMITS.providerMaxSessionSeconds
    ) {
      errors.push("evidence.limits.providerMaxSessionSeconds must be 600.")
    }
  }

  if (!isRecord(evidence.prerequisites)) {
    errors.push("evidence.prerequisites must be an object.")
  } else {
    for (const key of [
      "publicStartKeyAvailable",
      "privateManagementKeyAvailable",
      "baseImageCeilingSupported",
      "deploymentCeilingVerified",
      "sessionStatusAccessAvailable",
      "usageEvidenceAccessAvailable",
    ]) {
      assertBoolean(
        evidence.prerequisites,
        key,
        "evidence.prerequisites",
        errors
      )
    }
  }

  if (!Array.isArray(evidence.cases)) {
    errors.push("evidence.cases must be an array.")
  } else {
    const seen = new Set()
    evidence.cases.forEach((testCase, index) => {
      validateCase(
        testCase,
        `evidence.cases[${index}]`,
        evidence.observationMode,
        isRecord(limits) ? limits : REQUIRED_LIMITS,
        errors
      )
      if (isRecord(testCase) && typeof testCase.case === "string") {
        if (seen.has(testCase.case)) {
          errors.push(
            `evidence.cases contains duplicate case ${testCase.case}.`
          )
        }
        seen.add(testCase.case)
      }
    })
    for (const requiredCase of CASES) {
      if (!seen.has(requiredCase)) {
        errors.push(`evidence.cases is missing ${requiredCase}.`)
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, verdict: "invalid", errors, warnings }
  }

  if (evidence.observationMode !== "live") {
    warnings.push(
      "Synthetic evidence validates the harness only; A03 remains blocked on an authorized live provider exercise."
    )
    return { ok: true, verdict: "blocked_live_gate", errors, warnings }
  }

  return { ok: true, verdict: "pass", errors, warnings }
}
