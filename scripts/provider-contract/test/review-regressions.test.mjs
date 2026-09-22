import assert from "node:assert/strict"
import { createHmac, randomBytes } from "node:crypto"
import { readFile, writeFile, rename } from "node:fs/promises"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { test } from "node:test"
import * as runner from "../run.mjs"
import {
  active,
  dependencies,
  ended,
  identity,
  seed,
} from "./fixtures/state.mjs"
import { completeEvidence } from "./fixtures/projection.mjs"
import { fixtureChild, runDirectory } from "./fixtures/test-support.mjs"

async function seeded(t, options) {
  const dir = await runDirectory(t)
  const store = await runner.DurableRunStore.create(dir, identity)
  t.after(() => store.close())
  const ref = await seed(store, options)
  return { dir, store, ref }
}
async function reopen(t, store) {
  await store.close()
  const next = await runner.DurableRunStore.open(store.runDir)
  t.after(() => next.close())
  return next
}
async function checkpoint(dir) {
  return JSON.parse(await readFile(join(dir, "recovery.json"), "utf8"))
}
async function knownResponse(dir) {
  for (let n = 0; n < 200; n++) {
    const state = await checkpoint(dir)
    if (Object.keys(state.sessions).length) return state
    await delay(10)
  }
  throw new Error("response identity was never checkpointed")
}
function callback(port, sessionId = identity.sessionId) {
  const raw = JSON.stringify({
    runId: identity.runId,
    case: identity.caseId,
    bootId: identity.bootId,
    sessionId,
    event: "registered",
    observedAt: "2026-09-22T00:00:00Z",
  })
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
    },
    signal: AbortSignal.timeout(4000),
  })
}

// Review 1: run the actual first case to completion, including authenticated
// callbacks and browser-witness reports, with no provider accounting available.
test("live loop stops after one completed case when authoritative usage is unknown", async (t) => {
  const dir = await runDirectory(t)
  const child = fixtureChild(t, "signal-process.mjs", [dir, "complete-case"])
  const result = await child.message("boundaries")
  await child.exited
  assert.equal(result.starts, 1)
  const { records } = await runner.replayJournal(join(dir, "events.ndjson"))
  assert.ok(
    records.some(
      (record) =>
        record.kind === "callback" && record.payload.event === "agent_joined"
    )
  )
  assert.ok(
    records.some(
      (record) =>
        record.kind === "witness_observation" &&
        record.payload.event === "browser_joined"
    )
  )
  assert.ok(
    records.some(
      (record) =>
        record.kind === "session_status" && record.payload.terminal === true
    )
  )
  const summary = JSON.parse(await readFile(join(dir, "summary.json"), "utf8"))
  assert.equal(summary.confirmedBilledMinutes, null)
  assert.equal(summary.status, "blocked")
})

// Review 2: both processes see the same dead owner. Hold B's stale read until A
// owns the replacement, then release B. A correct takeover must recheck ownership.
test("concurrent stale takeover admits one writer and a denied closer cannot remove its lock", async (t) => {
  const dir = await runDirectory(t)
  const original = fixtureChild(t, "process.mjs", ["collector", dir])
  await original.message("ready")
  original.child.kill("SIGKILL")
  await original.exited
  const a = fixtureChild(t, "race-process.mjs", ["lock", dir])
  assert.equal((await a.message("phase")).phase, "stale-read")
  const b = fixtureChild(t, "race-process.mjs", ["lock", dir])
  const bFirst = await b.message("phase")
  a.child.send("release-read")
  assert.equal((await a.message("phase")).phase, "acquired")
  if (bFirst.phase === "stale-read") {
    b.child.send("release-read")
    assert.equal((await b.message("phase")).phase, "denied")
  } else assert.equal(bFirst.phase, "denied")
  b.child.send("close")
  await b.message("closed")
  assert.equal(
    JSON.parse(await readFile(join(dir, "writer.lock"), "utf8")).pid,
    a.child.pid
  )
  a.child.send("close")
  await a.message("closed")
})

test("closing a store never removes a replacement lock owned by another process", async (t) => {
  const { dir, store } = await seeded(t)
  const lockPath = join(dir, "writer.lock")
  const previous = JSON.parse(await readFile(lockPath, "utf8"))
  await rename(lockPath, join(dir, "previous-writer.lock"))
  await writeFile(
    lockPath,
    JSON.stringify({
      ...previous,
      pid: process.pid + 100_000,
      token: "replacement-owner",
    })
  )
  await store.close()
  assert.equal(
    JSON.parse(await readFile(lockPath, "utf8")).token,
    "replacement-owner"
  )
})

// Review 3: barriers must survive reopening, regardless of whether a read or a
// mutation first reported the permission error.
for (const code of [401, 403])
  test(`session read HTTP ${code} persistently blocks stop/delete across recovery`, async (t) => {
    const { store } = await seeded(t)
    const first = dependencies(store, {
      readSession: async () => {
        throw new Error(`provider_http_${code}`)
      },
    })
    assert.equal(await runner.cleanupRun(store, first.deps), false)
    assert.equal(
      first.calls.filter(
        ([name]) => name === "stopSession" || name === "deleteProbe"
      ).length,
      0
    )
    const next = await reopen(t, store)
    const second = dependencies(next, { readSession: async () => active })
    assert.equal(await runner.cleanupRun(next, second.deps), false)
    assert.equal(
      second.calls.filter(
        ([name]) => name === "stopSession" || name === "deleteProbe"
      ).length,
      0
    )
    assert.ok(second.calls.some(([name]) => name === "readProduction"))
  })

test("persisted stop permission error cannot be retried by a later cleanup", async (t) => {
  const { store, ref } = await seeded(t)
  await store.checkpoint((state) => {
    state.sessions[ref].stopAttempts = 1
    state.sessions[ref].stopHistory.push({
      status: "permission_error",
      httpStatus: 403,
      exitCode: 1,
    })
  })
  const next = await reopen(t, store)
  const { deps, calls } = dependencies(next, {
    readSession: async () => active,
  })
  assert.equal(await runner.cleanupRun(next, deps), false)
  assert.equal(
    calls.filter(([name]) => name === "stopSession" || name === "deleteProbe")
      .length,
    0
  )
  assert.equal(next.recovery.sessions[ref].stopAttempts, 1)
})

// Reviews 4 and 8: real response validation must retain a usable exact ID before
// rejecting independent token fields, and native parse messages must stay private.
for (const mode of ["missing-token", "malformed-token", "unbounded-token"])
  test(`invalid start response ${mode} retains exact containment identity without leaking provider content`, async (t) => {
    const dir = await runDirectory(t)
    const child = fixtureChild(t, "signal-process.mjs", [dir, mode])
    await child.message("boundaries")
    await child.exited
    const state = await checkpoint(dir)
    assert.equal(
      Object.values(state.sessions)[0]?.id,
      "response-session-canary"
    )
    assert.ok(
      Object.values(state.sessions)[0].sources.includes(
        "operator_start_response"
      )
    )
    const { records } = await runner.replayJournal(join(dir, "events.ndjson"))
    assert.ok(
      records.some(
        (record) => record.kind === "session_status" && record.payload.terminal
      )
    )
    for (const file of ["events.ndjson", "recovery.json", "summary.json"])
      assert.equal(
        (await readFile(join(dir, file), "utf8")).includes("credential-canary"),
        false
      )
    assert.equal(child.output().includes("credential-canary"), false)
    assert.equal(
      JSON.parse(await readFile(join(dir, "summary.json"), "utf8")).status,
      "blocked"
    )
  })

test("malformed token JSON produces a fixed error identifier, never the decoded provider content", () => {
  const token = `x.${Buffer.from("credential-canary").toString("base64url")}.x`
  assert.throws(
    () => runner.decodeClaims(token),
    (error) => {
      assert.equal(error.message.includes("credential-canary"), false)
      assert.match(error.message, /^[a-z_]+$/u)
      return true
    }
  )
})

test("failure predicate cannot persist raw provider text or private filesystem paths", async (t) => {
  const { store } = await seeded(t)
  await store.latchFailure({
    category: "operation_failed",
    predicate: "credential-canary /private/secret-path",
  })
  await store.writeSummary()
  for (const file of ["events.ndjson", "recovery.json", "summary.json"]) {
    const text = await readFile(join(store.runDir, file), "utf8")
    assert.equal(text.includes("credential-canary"), false)
    assert.equal(text.includes("secret-path"), false)
  }
})

// Review 5: expiry forbids a new retry window; it does not forbid one bounded
// exact-session snapshot before deleting evidence at the provider.
test("late recovery syncs available exact terminal/resource evidence before deletion without resetting deadline", async (t) => {
  const deadline = Date.now() - 1000
  const { store, ref } = await seeded(t, { deadline })
  const { deps, calls } = dependencies(store)
  const deletion = deps.deleteProbe
  deps.deleteProbe = async () => {
    const { records } = await runner.replayJournal(
      join(store.runDir, "events.ndjson")
    )
    assert.ok(
      records.some(
        (record) =>
          record.kind === "session_status" &&
          record.payload.sessionRef === ref &&
          record.payload.terminal &&
          record.payload.metricSampleCount === 2
      )
    )
    return deletion()
  }
  await runner.cleanupRun(store, deps)
  assert.equal(calls.filter(([name]) => name === "readSession").length, 1)
  assert.equal(calls.filter(([name]) => name === "deleteProbe").length, 1)
  assert.equal(calls.filter(([name]) => name === "stopSession").length, 0)
  assert.equal(store.recovery.sessions[ref].deadline, deadline)
  assert.ok(
    store.records.some((record) => record.payload.deadlineExceeded === true)
  )
})

// Review 6: the first request pauses at its first durable step while another
// signed HTTP request arrives. This exposes check-before-write races reliably.
for (const conflict of [false, true])
  test(`concurrent authenticated callbacks ${conflict ? "retain conflicting identities and fail the case" : "deduplicate one logical observation"}`, async (t) => {
    const { store } = await seeded(t, { session: false })
    const collector = await runner.startCollector({
      store,
      scratch: store.runDir,
    })
    t.after(() => collector.close())
    const registration = { ...identity }
    delete registration.sessionId
    collector.register(registration)
    const original = store.checkpoint.bind(store)
    let release
    let arrived
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const entered = new Promise((resolve) => {
      arrived = resolve
    })
    let first = true
    store.checkpoint = async (...args) => {
      if (first) {
        first = false
        arrived()
        await gate
      }
      return original(...args)
    }
    const a = callback(collector.port)
    await entered
    const b = callback(
      collector.port,
      conflict ? "second-exact-session" : identity.sessionId
    )
    await delay(80)
    release()
    const statuses = await Promise.all(
      [a, b].map(async (promise) => (await promise).status)
    )
    assert.deepEqual(statuses.sort(), conflict ? [204, 409] : [204, 204])
    assert.equal(
      store.records.filter((record) => record.kind === "callback").length,
      1
    )
    if (conflict) {
      assert.equal(Object.keys(store.recovery.sessions).length, 2)
      assert.ok(store.recovery.firstFailure)
      assert.ok(store.records.some((record) => record.kind === "first_failure"))
      await assert.rejects(
        collector.wait(identity.caseId, "registered", Date.now() + 100),
        /conflict/u
      )
    }
  })

test("a durable identity conflict blocks an otherwise complete six-case projection", () => {
  const { records, recovery } = completeEvidence()
  records.push({
    kind: "session_identity",
    caseRef: "cold_start",
    source: "conflicting_authenticated_callback",
    payload: { sessionRef: "other-session", conflict: true },
  })
  assert.equal(runner.projectSummary(records, recovery).status, "blocked")
})

// Review 7: send the first signal during the case, then the second while cleanup
// is inside the real request/CLI boundary. Node children simulate only the CLI.
for (const phase of ["read", "stop", "delete"])
  test(
    `second SIGTERM interrupts cleanup ${phase} and prevents later mutations`,
    { timeout: 8000 },
    async (t) => {
      const dir = await runDirectory(t)
      const child = fixtureChild(t, "signal-process.mjs", [
        dir,
        `cleanup-${phase}`,
      ])
      await child.message("response-returned")
      await knownResponse(dir)
      child.child.kill("SIGTERM")
      assert.equal((await child.message("cleanup-pending")).phase, phase)
      child.child.kill("SIGTERM")
      const result = await child.message("boundaries", 2500)
      await child.exited
      assert.equal(result.starts, 1)
      if (phase !== "delete")
        assert.equal(
          result.calls.filter((call) => call.includes("delete")).length,
          0
        )
      if (phase === "read")
        assert.ok(
          result.calls.some(
            ([name, target]) => name === "aborted" && target === "read"
          )
        )
      else
        assert.ok(
          result.calls.some(
            ([name, target, , signal]) =>
              name === "command-exit" &&
              target === phase &&
              signal === "SIGTERM"
          )
        )
      const state = await checkpoint(dir)
      assert.notEqual(state.cleanup.completed, true)
      assert.equal(state.starts, 1)
    }
  )

test("already-aborted cleanup never initiates a stop or deletion", async (t) => {
  const { store } = await seeded(t)
  const controller = new AbortController()
  controller.abort()
  const { deps, calls } = dependencies(store, {
    signal: controller.signal,
    readSession: async () => active,
  })
  await runner.cleanupRun(store, deps).catch(() => false)
  assert.equal(
    calls.filter(([name]) => name === "stopSession" || name === "deleteProbe")
      .length,
    0
  )
})

// Review 9: the browser opener is replaced in a separate process; the real
// collector writes both runtime witness pages with restrictive file permissions.
test("two sequential browser witnesses do not collide and retain mode 0600", async (t) => {
  const dir = await runDirectory(t)
  const child = fixtureChild(t, "race-process.mjs", ["witness", dir])
  const result = await child.message("witnesses")
  await child.exited
  assert.equal(result.error, null)
  assert.ok(result.witnesses.length > 0)
  for (const witness of result.witnesses) assert.equal(witness.mode, 0o600)
})

// Review 10: both stop paths spend from the same persisted envelope.
test("repeat stop uses the shared synced counter, fresh read and spacing; reopen cannot send a fourth stop", async (t) => {
  assert.equal(typeof runner.countedStop, "function")
  const { store, ref } = await seeded(t)
  let now = Date.now()
  await store.checkpoint((state) => {
    state.sessions[ref].stopAttempts = 2
    state.sessions[ref].lastStopAttemptAt = now
  })
  const events = []
  const { deps } = dependencies(store, {
    now: () => now,
    sleep: async (ms) => {
      events.push(["sleep", ms])
      now += ms
    },
    readSession: async (id) => {
      events.push(["read", id])
      return ended
    },
    stopSession: async (id) => {
      events.push(["stop", id])
      assert.equal(
        (await checkpoint(store.runDir)).sessions[ref].stopAttempts,
        3
      )
      return { status: "http_error", httpStatus: 404, exitCode: 1 }
    },
  })
  await runner.countedStop(store, ref, deps, "repeat_stop_session")
  assert.deepEqual(events, [
    ["sleep", 15_000],
    ["read", identity.sessionId],
    ["stop", identity.sessionId],
  ])
  assert.equal(store.recovery.sessions[ref].stopHistory.length, 1)
  assert.ok(
    store.records.some(
      (record) =>
        record.kind === "operation_result" &&
        record.payload.name === "repeat_stop_session"
    )
  )
  const next = await reopen(t, store)
  const noMore = dependencies(next)
  await assert.rejects(
    runner.countedStop(next, ref, noMore.deps, "repeat_stop_session"),
    /exhausted/u
  )
  assert.equal(
    noMore.calls.filter(([name]) => name === "stopSession").length,
    0
  )
})

test("ceiling completion observes exact process termination after media ejection and never sends stop", async (t) => {
  const { store, ref } = await seeded(t)
  // Media ejection alone cannot release the next case.
  await store.append({
    kind: "callback",
    source: "authenticated_probe",
    caseRef: identity.caseId,
    payload: {
      event: "agent_ejected",
      sessionRef: ref,
      dailyClaimsBounded: true,
    },
  })
  assert.throws(
    () => runner.assertCaseComplete(store.recovery, ref),
    /session_status_unknown/u
  )
  let reads = 0
  let now = Date.now()
  const { deps, calls } = dependencies(store, {
    observeOnly: true,
    now: () => now,
    sleep: async (ms) => {
      now += ms
    },
    readSession: async (id) => {
      assert.equal(id, identity.sessionId)
      return ++reads === 1 ? active : ended
    },
  })
  assert.equal((await runner.reconcileSession(store, ref, deps)).terminal, true)
  assert.equal(reads, 2)
  assert.equal(calls.filter(([name]) => name === "stopSession").length, 0)
  assert.throws(
    () => runner.assertCaseComplete(store.recovery, ref),
    /usage_unknown/u
  )
})

for (const billed of [null, undefined, NaN, Infinity, -1])
  test(`case advancement rejects confirmed usage with invalid amount ${String(billed)}`, () => {
    const recovery = {
      sessions: {
        exact: {
          terminal: true,
          usageStatus: "confirmed",
          confirmedBilledMinutes: billed,
        },
      },
    }
    assert.throws(
      () => runner.assertCaseComplete(recovery, "exact"),
      /usage_unknown/u
    )
  })

test("case advancement requires every session terminal, no first failure and remaining spend budget", () => {
  const recovery = {
    sessions: {
      exact: {
        terminal: true,
        usageStatus: "confirmed",
        confirmedBilledMinutes: 1,
      },
    },
  }
  assert.doesNotThrow(() => runner.assertCaseComplete(recovery, "exact"))
  recovery.sessions.other = {
    terminal: false,
    usageStatus: "unknown",
    confirmedBilledMinutes: null,
  }
  assert.throws(
    () => runner.assertCaseComplete(recovery, "exact"),
    /session_status_unknown/u
  )
  delete recovery.sessions.other
  recovery.firstFailure = { category: "callback_conflict" }
  assert.throws(
    () => runner.assertCaseComplete(recovery, "exact"),
    /callback_conflict/u
  )
  delete recovery.firstFailure
  recovery.sessions.exact.confirmedBilledMinutes = 72
  assert.throws(
    () => runner.assertCaseComplete(recovery, "exact"),
    /billing_limit_exceeded/u
  )
})

test("counted stop does not reset deadline or mutate after spacing reaches its existing deadline", async (t) => {
  const { store, ref } = await seeded(t)
  let now = Date.now()
  const deadline = now + 1000
  await store.checkpoint((state) => {
    Object.assign(state.sessions[ref], {
      stopAttempts: 2,
      lastStopAttemptAt: now,
      deadline,
    })
  })
  const { deps, calls } = dependencies(store, {
    now: () => now,
    sleep: async (ms) => {
      now += ms
    },
    readSession: async () => active,
  })
  await assert.rejects(
    runner.countedStop(store, ref, deps, "repeat_stop_session"),
    /deadline/u
  )
  assert.equal(now, deadline)
  assert.equal(store.recovery.sessions[ref].deadline, deadline)
  assert.equal(store.recovery.sessions[ref].stopAttempts, 2)
  assert.equal(calls.filter(([name]) => name === "stopSession").length, 0)
})

test("a killed stale-lock taker leaves an orphaned guard that fails closed without modifying evidence", async (t) => {
  const dir = await runDirectory(t)
  const original = fixtureChild(t, "process.mjs", ["collector", dir])
  await original.message("ready")
  original.child.kill("SIGKILL")
  await original.exited
  const taking = fixtureChild(t, "race-process.mjs", ["lock", dir])
  assert.equal((await taking.message("phase")).phase, "stale-read")
  taking.child.kill("SIGKILL")
  await taking.exited
  const files = ["events.ndjson", "recovery.json", "writer.lock"]
  const before = await Promise.all(
    files.map((file) => readFile(join(dir, file), "utf8"))
  )
  for (let attempt = 0; attempt < 2; attempt++)
    await assert.rejects(runner.DurableRunStore.open(dir), /run_writer_active/u)
  assert.deepEqual(
    await Promise.all(files.map((file) => readFile(join(dir, file), "utf8"))),
    before
  )
})
