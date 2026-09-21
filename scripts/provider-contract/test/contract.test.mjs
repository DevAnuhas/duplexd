import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { safeReference, validateEvidence } from "../lib/contract.mjs"

const testDirectory = dirname(fileURLToPath(import.meta.url))
const fixturePath = resolve(
  testDirectory,
  "../fixtures/synthetic-complete.json"
)
const cliPath = resolve(testDirectory, "../run.mjs")
const fixture = JSON.parse(await readFile(fixturePath, "utf8"))

const REQUIRED_CHECKS = {
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
}

const REQUIRED_SOURCES = [
  ["cold_start", "startResponseFields", "start_response"],
  ["cold_start", "registrationMatched", "runner_registration"],
  ["cancel_before_join", "knownSessionStopTargetStable", "stop_response"],
  ["cancel_before_join", "processTerminated", "provider_session_status"],
  ["cancel_before_join", "usageCeased", "provider_usage"],
  [
    "lost_start_response_registered",
    "registrationMatched",
    "runner_registration",
  ],
  [
    "lost_start_response_registered",
    "knownSessionStopTargetStable",
    "stop_response",
  ],
  [
    "lost_start_response_registered",
    "processTerminated",
    "provider_session_status",
  ],
  ["lost_start_response_registered", "usageCeased", "provider_usage"],
  [
    "no_registration_startup",
    "providerExecutionCeilingObserved",
    "provider_session_status",
  ],
  ["no_registration_startup", "browserEjected", "daily_browser_event"],
  ["no_registration_startup", "agentEjected", "daily_agent_event"],
  [
    "no_registration_startup",
    "processTerminated",
    "provider_session_status",
  ],
  ["no_registration_startup", "usageCeased", "provider_usage"],
  [
    "hung_runtime",
    "providerExecutionCeilingObserved",
    "provider_session_status",
  ],
  ["hung_runtime", "browserEjected", "daily_browser_event"],
  ["hung_runtime", "agentEjected", "daily_agent_event"],
  ["hung_runtime", "processTerminated", "provider_session_status"],
  ["hung_runtime", "usageCeased", "provider_usage"],
  [
    "known_session_stop_retry",
    "knownSessionStopTargetStable",
    "stop_response",
  ],
  [
    "known_session_stop_retry",
    "stop404Reconciled",
    "provider_session_status",
  ],
  [
    "known_session_stop_retry",
    "processTerminated",
    "provider_session_status",
  ],
  ["known_session_stop_retry", "usageCeased", "provider_usage"],
]

function cloneFixture() {
  return structuredClone(fixture)
}

function caseNamed(evidence, name) {
  const value = evidence.cases.find((candidate) => candidate.case === name)
  assert.ok(value, `fixture must contain ${name}`)
  return value
}

function assertInvalid(evidence, message) {
  const result = validateEvidence(evidence)
  assert.equal(result.ok, false)
  assert.equal(result.verdict, "invalid")
  assert.ok(
    result.errors.some((error) => error.includes(message)),
    `expected an error containing ${JSON.stringify(
      message
    )}, got:\n${result.errors.join("\n")}`
  )
  return result
}

test(
  "baseline synthetic fixture is valid but remains blocked on the live gate",
  () => {
    const result = validateEvidence(cloneFixture())

    assert.equal(result.ok, true)
    assert.equal(result.verdict, "blocked_live_gate")
    assert.deepEqual(result.errors, [])
    assert.match(
      result.warnings.join("\n"),
      /authorized live provider exercise/u
    )
  }
)

test(
  "safeReference is deterministic and never returns the raw reference",
  () => {
    const raw = "provider-session-123"
    const expected =
      "sha256:0e59376bac7f665d9dd63cd1cfc8bf18edfe50b948a98d2e537de63cb21e0f0f"

    assert.equal(safeReference(raw), expected)
    assert.equal(safeReference(raw), expected)
    assert.doesNotMatch(safeReference(raw), new RegExp(raw, "u"))
    assert.throws(() => safeReference(""), /non-empty reference/u)
  }
)

test("empty case references are rejected", async (t) => {
  for (const field of ["sessionRef", "callRef"]) {
    await t.test(field, () => {
      const evidence = cloneFixture()
      caseNamed(evidence, "cold_start")[field] = ""
      assertInvalid(evidence, `${field} must be a safe SHA-256 reference`)
    })
  }
})

test(
  "raw UUID case references are rejected rather than retained as evidence",
  async (t) => {
    for (const field of ["sessionRef", "callRef"]) {
      await t.test(field, () => {
        const evidence = cloneFixture()
        caseNamed(evidence, "cold_start")[field] =
          "123e4567-e89b-12d3-a456-426614174000"
        assertInvalid(evidence, "contains a raw UUID; use safeReference()")
      })
    }
  }
)

test(
  "credential-shaped values and credential fields are rejected",
  async (t) => {
    await t.test("Bearer value", () => {
      const evidence = cloneFixture()
      evidence.sourceFacts[0].claim = "Bearer raw-provider-credential"
      assertInvalid(evidence, "appears to contain a credential or raw token")
    })

    await t.test("secret-named field", () => {
      const evidence = cloneFixture()
      evidence.privateApiKey = "retained-value"
      assertInvalid(evidence, "must not retain a credential value")
    })
  }
)

test("every required case must appear exactly once", async (t) => {
  await t.test("missing case", () => {
    const evidence = cloneFixture()
    evidence.cases = evidence.cases.filter(
      (testCase) => testCase.case !== "hung_runtime"
    )
    assertInvalid(evidence, "cases is missing hung_runtime")
  })

  await t.test("duplicate case", () => {
    const evidence = cloneFixture()
    evidence.cases.push(structuredClone(caseNamed(evidence, "hung_runtime")))
    assertInvalid(evidence, "contains duplicate case hung_runtime")
  })
})

test("startup and whole-test overruns are rejected", async (t) => {
  await t.test("cold start exceeds 120 seconds", () => {
    const evidence = cloneFixture()
    caseNamed(evidence, "cold_start").readyAt = "2026-09-21T10:02:00.001Z"
    assertInvalid(evidence, "exceeded the startup bound")
  })

  await t.test("case exceeds 600 seconds", () => {
    const evidence = cloneFixture()
    caseNamed(evidence, "hung_runtime").ceasedAt = "2026-09-21T10:10:00.001Z"
    assertInvalid(evidence, "exceeded the whole-test bound")
  })
})

test("room ejection cannot be claimed as process or usage cessation", () => {
  const evidence = cloneFixture()
  caseNamed(evidence, "hung_runtime").cessationBoundary = "room_ejection"
  assertInvalid(evidence, "cannot use room ejection as process/usage proof")
})

test("all required checks are enforced for every case", async (t) => {
  for (const [caseName, checks] of Object.entries(REQUIRED_CHECKS)) {
    for (const check of checks) {
      await t.test(`${caseName}.${check}`, () => {
        const evidence = cloneFixture()
        delete caseNamed(evidence, caseName).checks[check]
        assertInvalid(evidence, `.checks.${check} must be true`)
      })
    }
  }
})

test("true checks require their documented observation source", async (t) => {
  for (const [caseName, check, source] of REQUIRED_SOURCES) {
    await t.test(`${caseName}.${check}`, () => {
      const evidence = cloneFixture()
      const testCase = caseNamed(evidence, caseName)
      testCase.observations = testCase.observations.filter(
        (observation) => observation.source !== source
      )
      assertInvalid(evidence, `.checks.${check} lacks a ${source} observation`)
    })
  }
})

test("observations must identify the containing case session", () => {
  const evidence = cloneFixture()
  caseNamed(evidence, "cold_start").observations[0].sessionRef =
    "sha256:9999999999999999999999999999999999999999999999999999999999999999"
  assertInvalid(evidence, "sessionRef must match the containing case")
})

test(
  "cases that assert stable exact-session cleanup require stop attempts",
  async (t) => {
    for (const caseName of [
      "cancel_before_join",
      "lost_start_response_registered",
      "known_session_stop_retry",
    ]) {
      await t.test(caseName, () => {
        const evidence = cloneFixture()
        delete caseNamed(evidence, caseName).stopAttempts
        assertInvalid(
          evidence,
          ".stopAttempts must contain exact-session cleanup evidence"
        )
      })
    }
  }
)

test(
  "cleanup cannot target a session different from the containing case",
  () => {
    const evidence = cloneFixture()
    caseNamed(evidence, "cancel_before_join").stopAttempts[0].sessionRef =
      caseNamed(evidence, "cold_start").sessionRef
    assertInvalid(
      evidence,
      "stopAttempts[0].sessionRef must match the containing case"
    )
  }
)

test("cleanup retries cannot mix target sessions", () => {
  const evidence = cloneFixture()
  const retry = caseNamed(evidence, "known_session_stop_retry")
  retry.stopAttempts[1].sessionRef = caseNamed(
    evidence,
    "cold_start"
  ).sessionRef
  assertInvalid(
    evidence,
    "stopAttempts must always target the same known session"
  )
})

test("known-session retry evidence requires at least two attempts", () => {
  const evidence = cloneFixture()
  caseNamed(evidence, "known_session_stop_retry").stopAttempts.splice(1)
  assertInvalid(evidence, "stopAttempts must demonstrate a retry")
})

test("known-session retry evidence requires a 404", () => {
  const evidence = cloneFixture()
  caseNamed(
    evidence,
    "known_session_stop_retry"
  ).stopAttempts[1].httpStatus = 200
  assertInvalid(evidence, "stopAttempts must include a reconciled 404")
})

test("a stop 404 cannot be treated as final without reconciliation", () => {
  const evidence = cloneFixture()
  caseNamed(
    evidence,
    "known_session_stop_retry"
  ).checks.stop404Reconciled = false
  assertInvalid(
    evidence,
    "treats a 404 as final without identity/status reconciliation"
  )
})

test(
  "a claimed 404 reconciliation requires exact-session status evidence",
  () => {
    const evidence = cloneFixture()
    const retry = caseNamed(evidence, "known_session_stop_retry")
    retry.observations = retry.observations.filter(
      (observation) => observation.source !== "provider_session_status"
    )
    assertInvalid(
      evidence,
      ".checks.stop404Reconciled lacks a provider_session_status observation"
    )
  }
)

test("every case requires media evidence", () => {
  const evidence = cloneFixture()
  delete caseNamed(evidence, "cancel_before_join").media
  assertInvalid(evidence, ".media must be an object")
})

test(
  "critical unknown and hung paths require same-session media evidence",
  async (t) => {
    for (const caseName of ["no_registration_startup", "hung_runtime"]) {
      await t.test(caseName, () => {
        const evidence = cloneFixture()
        caseNamed(evidence, caseName).media.sessionRef =
          caseNamed(evidence, "cold_start").sessionRef
        assertInvalid(
          evidence,
          ".media.sessionRef must match the containing case"
        )
      })
    }
  }
)

test(
  "room and participant expiry cannot exceed the containing case deadline",
  async (t) => {
    for (const participant of ["room", "browser", "agent"]) {
      await t.test(participant, () => {
        const evidence = cloneFixture()
        caseNamed(evidence, "hung_runtime").media[participant].expiresAt =
          "2026-09-21T10:10:00.001Z"
        assertInvalid(evidence, `.media.${participant}.expiresAt exceeds`)
      })
    }
  }
)

test(
  "room and both participant credentials must eject at expiry",
  async (t) => {
    for (const participant of ["room", "browser", "agent"]) {
      await t.test(participant, () => {
        const evidence = cloneFixture()
        delete caseNamed(evidence, "hung_runtime").media[participant]
          .ejectAtExpiry
        assertInvalid(
          evidence,
          `.media.${participant}.ejectAtExpiry must be true`
        )
      })
    }
  }
)

test("the browser participant cannot be an owner", () => {
  const evidence = cloneFixture()
  caseNamed(evidence, "hung_runtime").media.browser.isOwner = true
  assertInvalid(evidence, ".media.browser.isOwner must be false")
})

test("browser and agent credentials must be room-scoped", async (t) => {
  for (const participant of ["browser", "agent"]) {
    await t.test(participant, () => {
      const evidence = cloneFixture()
      caseNamed(evidence, "hung_runtime").media[participant].roomScoped = false
      assertInvalid(evidence, `.media.${participant}.roomScoped must be true`)
    })
  }
})

test("synthetic evidence cannot be relabeled live to obtain a pass", () => {
  const evidence = cloneFixture()
  evidence.observationMode = "live"
  assertInvalid(evidence, ".kind must match evidence.observationMode")
})

test(
  "CLI exits zero for the baseline and nonzero for invalid evidence",
  async () => {
    const success = spawnSync(
      process.execPath,
      [cliPath, "validate", fixturePath],
      { encoding: "utf8" }
    )
    assert.equal(success.status, 0, success.stderr)
    assert.equal(JSON.parse(success.stdout).verdict, "blocked_live_gate")

    const temporaryDirectory = await mkdtemp(join(testDirectory, ".cli-"))
    const invalidPath = join(temporaryDirectory, "invalid.json")
    try {
      const invalid = cloneFixture()
      invalid.cases = []
      await writeFile(invalidPath, `${JSON.stringify(invalid)}\n`)

      const failure = spawnSync(
        process.execPath,
        [cliPath, "validate", invalidPath],
        { encoding: "utf8" }
      )
      assert.equal(failure.status, 1, failure.stderr)
      assert.equal(JSON.parse(failure.stdout).verdict, "invalid")
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  }
)
