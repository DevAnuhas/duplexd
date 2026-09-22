import assert from "node:assert/strict"
import { fork } from "node:child_process"
import { createHmac, randomBytes } from "node:crypto"
import { once } from "node:events"
import { appendFile, mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import {
  CASES,
  applicationSessionIdentity,
  classifyStopCommandResult,
  DurableRunStore,
  cleanupRun,
  normalizeSessionObservation,
  projectSummary,
  reconcileSession,
  replayJournal,
  safeRef,
  startCollector,
} from "../run.mjs"
import {
  active,
  dependencies,
  ended,
  identity,
  production,
  seed,
} from "./fixtures/state.mjs"

const childPath = fileURLToPath(
  new URL("./fixtures/process.mjs", import.meta.url)
)

async function directory(t) {
  // Production rejects OS temporary directories and Git worktrees. These test-owned
  // directories live under the home directory and are always removed by the test.
  const parent = await mkdtemp(join(homedir(), ".duplexd-offline-test-"))
  t.after(() => rm(parent, { recursive: true, force: true }))
  return join(parent, "run")
}
async function storeFor(t, options = {}) {
  const dir = await directory(t)
  const store = await DurableRunStore.create(dir, identity)
  t.after(() => store.close())
  const ref = await seed(store, options)
  return { store, ref, dir }
}
function childFor(t, mode, dir) {
  const child = fork(
    mode === "signal"
      ? fileURLToPath(new URL("./fixtures/signal-process.mjs", import.meta.url))
      : childPath,
    mode === "signal" ? [dir] : [mode, dir],
    {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    }
  )
  let output = ""
  child.stdout.on("data", (chunk) => {
    output += chunk
  })
  child.stderr.on("data", (chunk) => {
    output += chunk
  })
  const messages = []
  const pending = []
  child.on("message", (message) => {
    const index = pending.findIndex((waiter) => waiter.type === message.type)
    if (index < 0) messages.push(message)
    else pending.splice(index, 1)[0].resolve(message)
  })
  const exited = once(child, "exit")
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL")
    await exited
  })
  return {
    child,
    exited,
    output: () => output,
    message(type) {
      const index = messages.findIndex((message) => message.type === type)
      if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0])
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`child message timeout: ${type}; ${output}`)),
          10_000
        )
        pending.push({
          type,
          resolve: (message) => {
            clearTimeout(timer)
            resolve(message)
          },
        })
      })
    },
  }
}
function callback(port, changes = {}, bodyChanges = {}) {
  const body = {
    runId: identity.runId,
    case: identity.caseId,
    bootId: identity.bootId,
    sessionId: identity.sessionId,
    event: "registered",
    observedAt: "2026-09-22T00:00:00.000Z",
    ...bodyChanges,
  }
  const raw = JSON.stringify(body)
  const timestamp = String(Math.floor(Date.now() / 1000))
  const nonce = randomBytes(16).toString("hex")
  const signature = createHmac("sha256", identity.secret)
    .update(`${timestamp}.${nonce}.`)
    .update(raw)
    .digest("hex")
  return fetch(`http://127.0.0.1:${port}${identity.path}`, {
    method: "POST",
    body: raw,
    headers: {
      "x-provider-proof-timestamp": timestamp,
      "x-provider-proof-nonce": nonce,
      "x-provider-proof-signature": signature,
      ...changes,
    },
    signal: AbortSignal.timeout(10_000),
  })
}
async function collectorFor(t, store) {
  const collector = await startCollector({ store, scratch: store.runDir })
  const { sessionId: _sessionId, ...registration } = identity
  collector.register(registration)
  t.after(() => collector.close())
  return collector
}
function assertNoCanaries(value) {
  for (const canary of [
    identity.sessionId,
    identity.runId,
    identity.organization,
    identity.bootId,
    identity.buildId,
    identity.deploymentId,
    "credential-canary",
    "provider-error-canary",
  ])
    assert.equal(value.includes(canary), false, `leaked ${canary}`)
}

test(
  "callback 204 waits for filesystem sync; SIGKILL then a separate process replays exact identity",
  { timeout: 20_000 },
  async (t) => {
    const dir = await directory(t)
    const writer = childFor(t, "collector", dir)
    const { port } = await writer.message("ready")
    writer.child.send("block-sync")
    await writer.message("armed")
    let responded = false
    const response = callback(port, {}, { extra: "credential-canary" }).then(
      (value) => {
        responded = true
        return value
      }
    )
    await writer.message("sync-blocked")
    await delay(80)
    assert.equal(
      responded,
      false,
      "collector acknowledged before the journal sync completed"
    )
    writer.child.send("release-sync")
    assert.equal((await response).status, 204)
    const durable = await replayJournal(join(dir, "events.ndjson"))
    assert.equal(
      durable.records.filter((record) => record.kind === "callback").length,
      1
    )
    writer.child.kill("SIGKILL")
    assert.deepEqual(await writer.exited, [null, "SIGKILL"])
    const reader = childFor(t, "recover", dir)
    const recovered = await reader.message("recovered")
    await reader.exited
    assert.equal(recovered.callbacks.length, 1)
    const retained = Object.values(recovered.recovery.sessions)
    assert.equal(retained.length, 1)
    assert.equal(retained[0].id, identity.sessionId)
    assert.deepEqual(
      recovered.calls
        .filter(([name]) => name === "readSession")
        .map(([, id]) => id),
      [identity.sessionId]
    )
    assertNoCanaries(await readFile(join(dir, "events.ndjson"), "utf8"))
    assertNoCanaries(await readFile(join(dir, "summary.json"), "utf8"))
    assertNoCanaries(writer.output() + reader.output())
  }
)

test("crash after synced start intent remains ambiguous; recovery issues zero starts and preserves deadlines", async (t) => {
  const dir = await directory(t)
  const writer = childFor(t, "signal", dir)
  await writer.message("dispatch-pending")
  const {
    dispatches: [{ deadline }],
  } = JSON.parse(await readFile(join(dir, "recovery.json"), "utf8"))
  writer.child.kill("SIGKILL")
  await writer.exited
  const reader = childFor(t, "recover", dir)
  const recovered = await reader.message("recovered")
  await reader.exited
  assert.equal(recovered.completed, false)
  assert.equal(recovered.recovery.dispatches[0].deadline, deadline)
  assert.equal(recovered.recovery.dispatches[0].outcome, "unknown")
  assert.equal(recovered.recovery.starts, 1)
  assert.equal(
    recovered.calls.filter(([name]) => name === "startSession").length,
    0
  )
  assert.equal(recovered.summary.confirmedBilledMinutes, null)
})

test("restricted evidence survives close and refuses a concurrent writer or existing run", async (t) => {
  const { store, dir } = await storeFor(t)
  assert.equal((await stat(dir)).mode & 0o777, 0o700)
  for (const file of ["events.ndjson", "recovery.json", "writer.lock"])
    assert.equal((await stat(join(dir, file))).mode & 0o777, 0o600)
  await assert.rejects(DurableRunStore.open(dir), /run_writer_active/u)
  await assert.rejects(DurableRunStore.create(dir, identity), /EEXIST/u)
  await store.close()
  const reopened = await DurableRunStore.open(dir)
  t.after(() => reopened.close())
  assert.equal(reopened.recovery.starts, 1)
})

test("first case failure survives independent stop failure and still captures production readback", async (t) => {
  const { store } = await storeFor(t)
  await store.latchFailure({
    caseRef: identity.caseId,
    operationRef: "registration",
    category: "callback_timeout",
    predicate: "registered",
  })
  const { deps, calls } = dependencies(store, {
    readSession: async () => active,
    stopSession: async () => {
      throw new Error("provider-error-canary credential-canary")
    },
  })
  assert.equal(await cleanupRun(store, deps), false)
  await store.latchFailure({ category: "cleanup_failed" })
  const summary = await store.writeSummary()
  assert.equal(summary.firstFailure.category, "callback_timeout")
  assert.equal(
    store.records.filter((record) => record.kind === "first_failure").length,
    1
  )
  assert.ok(
    store.records.some(
      (record) =>
        record.kind === "operation_result" &&
        record.payload.name === "stop_session" &&
        record.payload.status === "unknown"
    )
  )
  assert.ok(calls.some(([name]) => name === "readProduction"))
  assertNoCanaries(JSON.stringify(summary))
})

test("bounded retries persist counts across reopen, use fresh exact reads and 5/15-second spacing", async (t) => {
  const { store, ref, dir } = await storeFor(t)
  const deadline = store.recovery.sessions[ref].deadline
  let now = deadline - 720_000
  let crash = false
  const first = dependencies(store, {
    now: () => now,
    readSession: async (id) => {
      assert.equal(id, identity.sessionId)
      if (crash) throw new Error("simulated_process_loss")
      return active
    },
    stopSession: async () => {
      crash = true
      return { status: "timeout", httpStatus: null, exitCode: null }
    },
  })
  await assert.rejects(
    reconcileSession(store, ref, first.deps),
    /simulated_process_loss/u
  )
  await store.close()
  const reopened = await DurableRunStore.open(dir)
  t.after(() => reopened.close())
  assert.equal(reopened.recovery.sessions[ref].stopAttempts, 1)
  let reads = 0
  let stops = 1
  const events = []
  const { deps } = dependencies(reopened, {
    now: () => now,
    sleep: async (ms) => {
      events.push(["sleep", ms])
      now += ms
    },
    readSession: async (id) => {
      reads++
      events.push(["read", id])
      return stops === 3 ? ended : active
    },
    stopSession: async (id) => {
      events.push(["stop", id, now])
      stops++
      return { status: "timeout", httpStatus: null, exitCode: null }
    },
  })
  assert.equal((await reconcileSession(reopened, ref, deps)).terminal, true)
  assert.equal(reopened.recovery.sessions[ref].stopAttempts, 3)
  assert.equal(reopened.recovery.sessions[ref].deadline, deadline)
  assert.deepEqual(
    events.filter(([name]) => name === "sleep").map(([, ms]) => ms),
    [5_000, 15_000]
  )
  for (const [index, event] of events.entries())
    if (event[0] === "stop") {
      assert.equal(event[1], identity.sessionId)
      assert.deepEqual(events[index - 1], ["read", identity.sessionId])
    }
  assert.ok(reads >= 3)
})

for (const outcome of [
  { status: "success", httpStatus: null, exitCode: 0 },
  { status: "http_error", httpStatus: 404, exitCode: 1 },
  { status: "permission_error", httpStatus: 403, exitCode: 1 },
])
  test(`stop result ${outcome.status} retains actual status and cannot itself prove termination`, async (t) => {
    const { store, ref } = await storeFor(t)
    const { deps } = dependencies(store, {
      readSession: async () => active,
      stopSession: async () => outcome,
    })
    await assert.rejects(
      reconcileSession(store, ref, deps),
      outcome.status === "permission_error"
        ? /session_permission_denied/u
        : /session_stop_exhausted/u
    )
    const results = store.records.filter(
      (record) =>
        record.kind === "operation_result" &&
        record.payload.name === "stop_session"
    )
    assert.equal(results.length, outcome.status === "permission_error" ? 1 : 3)
    for (const result of results) {
      assert.equal(result.payload.status, outcome.status)
      assert.equal(result.payload.httpStatus, outcome.httpStatus)
    }
    assert.equal(store.recovery.sessions[ref].terminal, false)
  })

test("real 404 needs an independent exact terminal read", async (t) => {
  const { store, ref } = await storeFor(t)
  let stopped = false
  const { deps } = dependencies(store, {
    readSession: async () => (stopped ? ended : active),
    stopSession: async () => {
      stopped = true
      return { status: "http_error", httpStatus: 404, exitCode: 1 }
    },
  })
  assert.equal((await reconcileSession(store, ref, deps)).terminal, true)
  assert.equal(store.recovery.sessions[ref].stopAttempts, 1)
})

test("deadline exhaustion never resets the deadline or manufactures terminal status", async (t) => {
  const { store, ref } = await storeFor(t, { deadline: Date.now() - 1 })
  const deadline = store.recovery.sessions[ref].deadline
  const { deps, calls } = dependencies(store)
  assert.equal(await cleanupRun(store, deps), false)
  assert.equal(store.recovery.sessions[ref].deadline, deadline)
  assert.equal(store.recovery.sessions[ref].terminal, false)
  assert.ok(
    calls.some(([name]) => name === "deleteProbe"),
    "late recovery still attempts scoped containment"
  )
})

test("null usage stays null for missing, changing and unchanged metrics; runtime is only an estimate", () => {
  for (const sample of [
    active,
    ended,
    { ...ended, resourceMetrics: null },
    {
      ...ended,
      resourceMetrics: { sampleCount: 10, timeseries: [{ t: 999 }] },
    },
  ]) {
    const value = normalizeSessionObservation(sample)
    assert.equal(value.confirmedBilledMinutes, null)
    assert.equal(value.usageStatus, "unknown")
  }
  assert.equal(normalizeSessionObservation(ended).observedRuntimeMinutes, 1)
})

test("durable terminal/resource evidence precedes delete; repeated recovery skips confirmed mutations", async (t) => {
  const { store, ref, dir } = await storeFor(t)
  const deadline = store.recovery.sessions[ref].deadline
  const { deps, calls } = dependencies(store)
  const deleteProbe = deps.deleteProbe
  deps.deleteProbe = async () => {
    const { records } = await replayJournal(join(dir, "events.ndjson"))
    assert.ok(
      records.some(
        (record) =>
          record.kind === "session_status" &&
          record.payload.terminal &&
          record.payload.metricSampleCount === 2
      )
    )
    return deleteProbe()
  }
  assert.equal(await cleanupRun(store, deps), true)
  await store.close()
  const reopened = await DurableRunStore.open(dir)
  t.after(() => reopened.close())
  assert.equal(await cleanupRun(reopened, deps), true)
  assert.equal(calls.filter(([name]) => name === "deleteProbe").length, 1)
  assert.equal(calls.filter(([name]) => name === "stopSession").length, 0)
  assert.equal(reopened.recovery.sessions[ref].deadline, deadline)
  const summary = await reopened.writeSummary()
  assert.equal(summary.confirmedBilledMinutes, null)
  assert.notEqual(summary.status, "pass")
})

test("truncated final journal tail retains valid prefix and cannot become a pass after recovery", async (t) => {
  const { store, dir } = await storeFor(t)
  await store.close()
  const prefix = await readFile(join(dir, "events.ndjson"), "utf8")
  const tail = '{"schemaVersion":1,"sequence":'
  await appendFile(join(dir, "events.ndjson"), tail)
  const before = await replayJournal(join(dir, "events.ndjson"))
  assert.equal(before.truncatedTail, true)
  const reopened = await DurableRunStore.open(dir)
  t.after(() => reopened.close())
  const { deps, calls } = dependencies(reopened)
  await cleanupRun(reopened, deps)
  assert.ok(calls.some(([name]) => name === "deleteProbe"))
  assert.notEqual((await reopened.writeSummary()).status, "pass")
  const after = await replayJournal(join(dir, "events.ndjson"))
  assert.deepEqual(
    after.records.slice(0, before.records.length),
    before.records
  )
  assert.ok(
    (await readFile(join(dir, "events.ndjson"), "utf8")).startsWith(prefix)
  )
})

for (const corrupt of [
  "not-json\n",
  '{"schemaVersion":1,"sequence":999,"kind":"callback"}\n',
])
  test(`invalid journal refuses replay: ${corrupt.startsWith("not") ? "syntax" : "sequence gap"}`, async (t) => {
    const { store, dir } = await storeFor(t)
    await store.close()
    await appendFile(join(dir, "events.ndjson"), corrupt)
    await assert.rejects(
      DurableRunStore.open(dir),
      /journal_invalid|journal_sequence_gap/u
    )
  })

test("disk sync failure never acknowledges callback and leaves exact identity available for containment", async (t) => {
  const dir = await directory(t)
  const writer = childFor(t, "collector", dir)
  const { port } = await writer.message("ready")
  writer.child.send("fail-sync")
  await writer.message("armed")
  assert.equal((await callback(port)).status, 503)
  assert.equal((await callback(port)).status, 503)
  const recovery = JSON.parse(
    await readFile(join(dir, "recovery.json"), "utf8")
  )
  assert.equal(Object.values(recovery.sessions)[0].id, identity.sessionId)
  writer.child.send("contain")
  const result = await writer.message("contained")
  assert.ok(result.calls.some(([name]) => name === "readSession"))
  assert.notEqual(result.summary.status, "pass")
  assertNoCanaries(writer.output())
})

test("authenticated retries with fresh nonces deduplicate; conflicting retry cannot replace evidence", async (t) => {
  const { store } = await storeFor(t, { session: false })
  const collector = await collectorFor(t, store)
  assert.equal((await callback(collector.port)).status, 204)
  assert.equal((await callback(collector.port)).status, 204)
  assert.equal(
    (
      await callback(
        collector.port,
        {},
        { observedAt: "2026-09-22T00:00:01.000Z" }
      )
    ).status,
    409
  )
  assert.equal(
    store.records.filter((record) => record.kind === "callback").length,
    1
  )
})

for (const event of ["registered", "agent_joined"])
  test(`lost response identity from ${event} is labeled for the correct recovery owner`, async (t) => {
    const { store, ref } = await storeFor(t, {
      sources: ["operator_start_response"],
    })
    const collector = await collectorFor(t, store)
    assert.equal((await callback(collector.port, {}, { event })).status, 204)
    let stopped = false
    const { deps } = dependencies(store, {
      readSession: async () => (stopped ? ended : active),
      stopSession: async () => {
        stopped = true
        return { status: "success", httpStatus: null, exitCode: 0 }
      },
    })
    await reconcileSession(store, ref, deps)
    const intent = store.records.find(
      (record) =>
        record.kind === "operation_intent" &&
        record.payload.name === "stop_session"
    )
    assert.equal(
      intent.source,
      event === "registered" ? "application_recovery" : "operator_intervention"
    )
    if (event !== "registered")
      assert.equal(collector.has(identity.caseId, "registered"), false)
  })

test("callback provider canaries cannot enter journal, summary or private recovery beyond allowed identifiers", async (t) => {
  const { store } = await storeFor(t, { session: false })
  const collector = await collectorFor(t, store)
  assert.equal(
    (await callback(collector.port, {}, { arbitrary: "credential-canary" }))
      .status,
    204
  )
  assertNoCanaries(JSON.stringify(store.records))
  assertNoCanaries(JSON.stringify(await store.writeSummary()))
  assert.equal(
    JSON.stringify(store.recovery).includes("credential-canary"),
    false
  )
})

for (const mismatch of ["probe", "production"])
  test(`${mismatch} ownership mismatch keeps cleanup blocked and protects the mismatched target`, async (t) => {
    const { store } = await storeFor(t)
    const { deps, calls } = dependencies(
      store,
      mismatch === "probe"
        ? {
            readProbe: async () => ({
              manifest: {
                agentName: store.recovery.serviceName,
                buildId: "unowned-build",
                deploymentId: "unowned-deployment",
              },
              sessions: [],
            }),
          }
        : {
            readProduction: async () => ({
              ...production,
              manifest: {
                ...production.manifest,
                buildId: "changed-production",
              },
            }),
          }
    )
    assert.equal(await cleanupRun(store, deps), false)
    assert.equal(
      calls.filter(([name]) => name === "stopSession" || name === "deleteProbe")
        .length,
      mismatch === "probe" ? 0 : 1
    )
  })

test("summary cannot promote a bare pass verdict with no required observations", () => {
  const summary = projectSummary(
    [{ kind: "verdict", payload: { status: "pass", reason: "claimed" } }],
    { salt: "salt", runId: "run", sessions: {}, cleanup: { completed: true } }
  )
  assert.notEqual(summary.status, "pass")
})

test("six claimed cases plus confirmed checkpoint usage cannot replace actual required observations", () => {
  const records = CASES.map(({ id }) => ({
    caseRef: id,
    kind: "verdict",
    payload: { status: "pass" },
  }))
  records.push({ kind: "verdict", payload: { status: "pass" } })
  const recovery = {
    salt: "salt",
    runId: "run",
    starts: 6,
    dispatches: [],
    sessions: Object.fromEntries(
      CASES.map(({ id }) => [
        id,
        { usageStatus: "confirmed", confirmedBilledMinutes: 1 },
      ])
    ),
    cleanup: {
      completed: true,
      probeServiceAbsent: true,
      productionUnchanged: true,
    },
  }
  assert.notEqual(projectSummary(records, recovery).status, "pass")
})

test("truncated tail after an already latched failure preserves that failure and still contains", async (t) => {
  const { store, dir } = await storeFor(t)
  await store.latchFailure({
    category: "operator_signal",
    caseRef: identity.caseId,
  })
  await store.close()
  await appendFile(join(dir, "events.ndjson"), '{"unfinished":')
  const reopened = await DurableRunStore.open(dir)
  t.after(() => reopened.close())
  const { deps, calls } = dependencies(reopened)
  await cleanupRun(reopened, deps)
  assert.ok(calls.some(([name]) => name === "deleteProbe"))
  assert.equal(
    (await reopened.writeSummary()).firstFailure.category,
    "operator_signal"
  )
  assert.equal(
    (await replayJournal(join(dir, "events.ndjson"))).truncatedTail,
    true
  )
})

test("a permission failure stops subsequent destructive cleanup", async (t) => {
  const { store } = await storeFor(t)
  const { deps, calls } = dependencies(store, {
    readSession: async () => active,
    stopSession: async () => ({
      status: "permission_error",
      httpStatus: 403,
      exitCode: 1,
    }),
  })
  assert.equal(await cleanupRun(store, deps), false)
  assert.equal(calls.filter(([name]) => name === "deleteProbe").length, 0)
  assert.ok(calls.some(([name]) => name === "readProduction"))
})

test("one unresolved session does not skip exact evidence collection for another", async (t) => {
  const { store } = await storeFor(t)
  const secondId = "second-owned-session"
  const secondRef = safeRef(store.recovery.salt, secondId)
  await store.checkpoint((recovery) => {
    recovery.sessions[secondRef] = {
      ...structuredClone(Object.values(recovery.sessions)[0]),
      id: secondId,
    }
  })
  const observed = []
  const { deps } = dependencies(store, {
    readSession: async (id) => {
      observed.push(id)
      if (id === identity.sessionId) throw new Error("provider_network_failure")
      return ended
    },
  })
  assert.equal(await cleanupRun(store, deps), false)
  assert.deepEqual(observed, [identity.sessionId, secondId])
  assert.equal(store.recovery.sessions[secondRef].terminal, true)
})

test("conflicting authenticated session retains both exact candidates and blocks the case", async (t) => {
  const { store } = await storeFor(t, { session: false })
  const collector = await collectorFor(t, store)
  assert.equal((await callback(collector.port)).status, 204)
  assert.notEqual(
    (await callback(collector.port, {}, { sessionId: "conflicting-session" }))
      .status,
    204
  )
  assert.deepEqual(
    Object.values(store.recovery.sessions)
      .map((session) => session.id)
      .sort(),
    [identity.sessionId, "conflicting-session"].sort()
  )
  assert.equal(
    store.records.filter((record) => record.kind === "callback").length,
    1
  )
  assert.ok(
    store.records.some(
      (record) =>
        record.kind === "session_identity" && record.payload.conflict === true
    )
  )
})

test("callback auth rejects invalid signature without persisting or exposing session identity", async (t) => {
  const { store } = await storeFor(t, { session: false })
  const collector = await collectorFor(t, store)
  const count = store.records.length
  assert.equal(
    (
      await callback(collector.port, {
        "x-provider-proof-signature": "0".repeat(64),
      })
    ).status,
    401
  )
  assert.equal(store.records.length, count)
  assert.equal(Object.keys(store.recovery.sessions).length, 0)
})

test("provider error canaries in normalized state and timestamps cannot leak to evidence", async (t) => {
  const { store, ref } = await storeFor(t)
  const { deps } = dependencies(store, {
    readSession: async () => ({
      ...ended,
      status: "provider-error-canary",
      updatedAt: "credential-canary",
    }),
  })
  await reconcileSession(store, ref, deps)
  assertNoCanaries(JSON.stringify(store.records))
  assertNoCanaries(JSON.stringify(await store.writeSummary()))
})

test(
  "real CLI SIGTERM aborts active dispatch, contains with fresh requests, and repeated recovery never redispatches",
  { timeout: 20_000 },
  async (t) => {
    const dir = await directory(t)
    const writer = childFor(t, "signal", dir)
    await writer.message("dispatch-pending")
    const before = JSON.parse(
      await readFile(join(dir, "recovery.json"), "utf8")
    )
    writer.child.kill("SIGTERM")
    const boundaries = await writer.message("boundaries")
    const [code] = await writer.exited
    assert.equal(code, 1)
    assert.equal(boundaries.starts, 1)
    assert.equal(
      boundaries.calls.filter((call) => call.includes("delete")).length,
      1
    )
    assertNoCanaries(writer.output())
    for (let attempt = 0; attempt < 2; attempt++) {
      const reader = childFor(t, "recover", dir)
      const result = await reader.message("recovered")
      await reader.exited
      assert.equal(result.recovery.starts, 1)
      assert.equal(
        result.recovery.dispatches[0].deadline,
        before.dispatches[0].deadline
      )
      assert.equal(result.recovery.dispatches[0].outcome, "unknown")
      assert.equal(
        result.calls.filter(([name]) => name === "startSession").length,
        0
      )
      assert.notEqual(result.summary.status, "pass")
    }
  }
)

test("lost-response application identity cannot fall back to the operator witness ID", () => {
  const operatorId = "hidden-operator-identity"
  for (const definition of CASES.filter((item) => item.discard)) {
    assert.equal(applicationSessionIdentity(definition, operatorId, null), null)
    assert.equal(
      applicationSessionIdentity(definition, operatorId, "registered-identity"),
      "registered-identity"
    )
  }
  assert.equal(
    applicationSessionIdentity(CASES[0], operatorId, null),
    operatorId
  )
})

test("actual stop classifier separates repeated CLI success, numeric HTTP 404, permission, timeout and transport errors", () => {
  for (const [input, expected] of [
    [
      { status: "success", exitCode: 0, output: "stopped" },
      { status: "success", exitCode: 0, httpStatus: null },
    ],
    [
      { status: "cli_failure", exitCode: 1, output: "HTTP 404" },
      { status: "http_error", exitCode: 1, httpStatus: 404 },
    ],
    [
      {
        status: "cli_failure",
        exitCode: 1,
        output: "forbidden credential-canary",
      },
      { status: "permission_error", exitCode: 1, httpStatus: null },
    ],
    [
      { status: "timeout", exitCode: null, output: "credential-canary" },
      { status: "timeout", exitCode: null, httpStatus: null },
    ],
    [
      {
        status: "network_failure",
        exitCode: null,
        output: "credential-canary",
      },
      { status: "network_failure", exitCode: null, httpStatus: null },
    ],
  ])
    assert.deepEqual(classifyStopCommandResult(input), expected)
})

test("not-found prose without observed HTTP status cannot manufacture numeric 404", () => {
  const result = classifyStopCommandResult({
    status: "cli_failure",
    exitCode: 1,
    output: "session not found",
  })
  assert.equal(result.httpStatus, null)
})

test("authenticated callback rejects unbounded Daily claims before durable acknowledgement", async (t) => {
  const { store } = await storeFor(t, { session: false })
  const collector = await collectorFor(t, store)
  const { sessionId: _sessionId, ...registration } = identity
  collector.register({ ...registration, expiresAtEpochSeconds: 300 })
  const claims = {
    expiresAtEpochSeconds: 300,
    ejectAtTokenExpiry: true,
    isOwner: false,
    roomScoped: true,
  }
  assert.equal(
    (
      await callback(
        collector.port,
        {},
        { dailyClaims: { ...claims, isOwner: true } }
      )
    ).status,
    401
  )
  assert.equal(Object.keys(store.recovery.sessions).length, 0)
  assert.equal(
    (await callback(collector.port, {}, { dailyClaims: claims })).status,
    204
  )
  assert.equal(
    store.records.find((record) => record.kind === "callback").payload
      .dailyClaimsBounded,
    true
  )
})
