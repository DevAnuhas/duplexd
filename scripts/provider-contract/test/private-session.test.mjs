import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { test } from "node:test"
import * as runner from "../run.mjs"
import {
  active,
  dependencies,
  ended,
  identity,
  seed,
} from "./fixtures/state.mjs"
import { fixtureChild, runDirectory } from "./fixtures/test-support.mjs"

const scope = {
  organization: "fixture-namespace",
  organizationId: "22222222-2222-4222-8222-222222222222",
  serviceName: "duplexd-provider-proof",
  probe: {
    serviceId: "33333333-3333-4333-8333-333333333333",
    deploymentId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  },
}
const sessionId = "11111111-2222-4333-8444-555555555555"
const detail = () => ({
  ...ended,
  sessionId,
  serviceId: scope.probe.serviceId,
  deploymentId: scope.probe.deploymentId,
  organizationId: scope.organizationId,
  resourceMetrics: { ...ended.resourceMetrics, sessionId },
})
const request = () => ({
  privateKey: "private-key-canary",
  recovery: structuredClone(scope),
  sessionId,
})
async function seeded(t, options = {}) {
  const dir = await runDirectory(t)
  const store = await runner.DurableRunStore.create(dir, identity)
  t.after(() => store.close())
  const ref = await seed(store, options)
  return { store, ref, dir }
}

test("exact GET/DELETE use documented private-key URLs and retain real HTTP outcomes", async (t) => {
  const calls = []
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push([url, options.method, options.headers.authorization])
    return Response.json(
      options.method === "DELETE"
        ? { status: "terminated", session_id: sessionId }
        : detail()
    )
  })
  assert.equal((await runner.readExactSession(request())).sessionId, sessionId)
  assert.deepEqual(await runner.stopExactSession(request()), {
    status: "success",
    httpStatus: 200,
  })
  const expected = `https://api.pipecat.daily.co/v1/agents/duplexd-provider-proof/sessions/${sessionId}`
  assert.deepEqual(calls, [
    [expected, "GET", "Bearer private-key-canary"],
    [expected, "DELETE", "Bearer private-key-canary"],
  ])
})

for (const field of [
  "sessionId",
  "serviceId",
  "organizationId",
  "deploymentId",
  "resourceMetrics.sessionId",
])
  test(`exact GET rejects mismatched ${field}`, async (t) => {
    const response = detail()
    if (field.includes("."))
      response.resourceMetrics.sessionId = "foreign-session"
    else response[field] = "foreign-identity"
    t.mock.method(globalThis, "fetch", async () => Response.json(response))
    await assert.rejects(
      runner.readExactSession(request()),
      /identity_mismatch|scope_mismatch/u
    )
  })

for (const field of [
  "sessionId",
  "serviceId",
  "organizationId",
  "deploymentId",
])
  test(`exact GET rejects missing required ${field}`, async (t) => {
    const response = detail()
    delete response[field]
    t.mock.method(globalThis, "fetch", async () => Response.json(response))
    await assert.rejects(
      runner.readExactSession(request()),
      /identity_mismatch|scope_mismatch/u
    )
  })

for (const body of [
  { status: "terminated", session_id: "foreign-session" },
  { status: "pending", session_id: sessionId },
])
  test(`DELETE does not accept mismatched identity or result ${body.status}/${body.session_id}`, async (t) => {
    t.mock.method(globalThis, "fetch", async () => Response.json(body))
    assert.equal(
      (await runner.stopExactSession(request())).status,
      "invalid_response"
    )
  })

for (const code of [401, 403, 404, 429, 500])
  test(`DELETE preserves actual HTTP ${code} independently from termination`, async (t) => {
    t.mock.method(globalThis, "fetch", async () =>
      Response.json({ error: "credential-canary" }, { status: code })
    )
    const result = await runner.stopExactSession(request())
    assert.equal(result.httpStatus, code)
    assert.equal(
      result.status,
      [401, 403].includes(code) ? "permission_error" : "http_error"
    )
    assert.equal(JSON.stringify(result).includes("credential-canary"), false)
  })

test("non-JSON permission response still preserves HTTP 403 and does not leak provider text", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response("credential-canary", { status: 403 })
  )
  const result = await runner.stopExactSession(request())
  assert.equal(result.httpStatus, 403)
  assert.equal(result.status, "permission_error")
  assert.equal(JSON.stringify(result).includes("credential-canary"), false)
})

test("exact GET 404 stays unknown rather than becoming a terminal observation", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({}, { status: 404 })
  )
  await assert.rejects(runner.readExactSession(request()), /provider_http_404/u)
})

test("missing private key fails before HTTP and before actual CLI provider mutations", async (t) => {
  let calls = 0
  t.mock.method(globalThis, "fetch", async () => {
    calls++
    throw new Error("unexpected_request")
  })
  for (const invoke of [
    runner.readExactSession,
    runner.stopExactSession,
    runner.readActiveSessions,
  ])
    await assert.rejects(
      invoke({ ...request(), privateKey: undefined }),
      /private_key_missing/u
    )
  assert.equal(calls, 0)
  const dir = await runDirectory(t)
  const child = fixtureChild(t, "signal-process.mjs", [
    dir,
    "missing-private-key",
  ])
  const boundaries = await child.message("boundaries")
  assert.equal((await child.exited)[0], 1)
  assert.equal(boundaries.starts, 0)
  assert.deepEqual(boundaries.calls, [])
})

for (const [label, body, complete] of [
  ["explicit complete zero", { total_count: 0, sessions: [] }, true],
  ["bare empty rows", [], false],
  ["missing total", { sessions: [] }, false],
  ["unfetched rows", { total_count: 1, sessions: [] }, false],
  ["contradictory total", { total_count: 0, sessions: [detail()] }, false],
  ["active row", { total_count: 1, sessions: [detail()] }, false],
])
  test(`scoped active readback: ${label}`, async (t) => {
    t.mock.method(globalThis, "fetch", async (url, options) => {
      const parsed = new URL(url)
      assert.equal(
        parsed.pathname,
        "/v1/agents/duplexd-provider-proof/sessions"
      )
      assert.equal(parsed.searchParams.get("status"), "active")
      assert.equal(
        parsed.searchParams.get("deploymentId"),
        scope.probe.deploymentId
      )
      assert.equal(parsed.searchParams.get("offset"), "0")
      assert.equal(options.headers.authorization, "Bearer private-key-canary")
      return Response.json(body)
    })
    const result = await runner.readActiveSessions(request())
    assert.equal(result.complete, complete)
    assert.equal(result.activeSessionCount, complete ? 0 : null)
  })

test("six persisted dispatch reservations consume 72 minutes including unknown outcomes; seventh and duplicate cannot mutate budget", async (t) => {
  const dir = await runDirectory(t)
  let store = await runner.DurableRunStore.create(dir, identity)
  t.after(() => store.close())
  const now = Date.now()
  for (let index = 0; index < 6; index++) {
    await runner.reserveStart(store, {
      dispatchRef: `dispatch-${index}`,
      caseRef: runner.CASES[index].id,
      deadline: now + 720_000,
      dispatchedAt: now,
    })
    const disk = JSON.parse(await readFile(join(dir, "recovery.json"), "utf8"))
    assert.equal(disk.starts, index + 1)
    assert.equal(disk.reservedSessionMinutes, (index + 1) * 12)
    assert.equal(disk.dispatches[index].reservedMinutes, 12)
    assert.equal(disk.dispatches[index].outcome, "unknown")
    if (index === 0) {
      await assert.rejects(
        runner.reserveStart(store, { dispatchRef: "dispatch-0" }),
        /ambiguous_start_no_retry/u
      )
      await store.close()
      store = await runner.DurableRunStore.open(dir)
    }
  }
  const before = await readFile(join(dir, "recovery.json"), "utf8")
  await assert.rejects(
    runner.reserveStart(store, { dispatchRef: "seventh" }),
    /reservation_limit_exceeded/u
  )
  assert.equal(await readFile(join(dir, "recovery.json"), "utf8"), before)
  await store.close()
  store = await runner.DurableRunStore.open(dir)
  const { deps } = dependencies(store)
  await runner.cleanupRun(store, deps)
  assert.equal(store.recovery.reservedSessionMinutes, 72)
  assert.equal(store.recovery.starts, 6)
  assert.ok(
    store.recovery.dispatches.every(
      (dispatch) => dispatch.deadline === now + 720_000
    )
  )
})

for (const condition of [
  "active",
  "unknown-read",
  "real-404",
  "permission",
  "deadline",
  "accepted-no-identity",
  "ambiguous-no-identity",
  "incomplete-active-list",
  "bare-empty-active-list",
  "failed-active-list",
  "active-provider-row",
])
  test(`cleanup retains service and recovery for ${condition}`, async (t) => {
    const noIdentity = condition.endsWith("no-identity")
    const { store, dir } = await seeded(t, {
      session: !noIdentity,
      outcome: condition === "ambiguous-no-identity" ? "unknown" : "accepted",
      ...(condition === "deadline" ? { deadline: Date.now() - 1 } : {}),
    })
    const overrides = { waitForUnknown: false }
    if (["active", "deadline"].includes(condition))
      overrides.readSession = async () => active
    if (condition === "unknown-read") overrides.readSession = async () => null
    if (condition === "real-404")
      overrides.readSession = async () => {
        throw new Error("provider_http_404")
      }
    if (condition === "permission")
      overrides.readSession = async () => {
        throw new Error("provider_http_403")
      }
    if (condition === "incomplete-active-list")
      overrides.readActiveSessions = async () => ({
        complete: false,
        activeSessionCount: null,
      })
    if (condition === "bare-empty-active-list")
      overrides.readActiveSessions = async () => []
    if (condition === "failed-active-list")
      overrides.readActiveSessions = async () => {
        throw new Error("provider_network_failure")
      }
    if (condition === "active-provider-row")
      overrides.readActiveSessions = async () => ({
        complete: true,
        activeSessionCount: 1,
      })
    const { deps, calls } = dependencies(store, overrides)
    assert.equal(await runner.cleanupRun(store, deps), false)
    assert.equal(calls.filter(([name]) => name === "deleteProbe").length, 0)
    assert.notEqual(store.recovery.cleanup.probeServiceAbsent, true)
    assert.ok(JSON.parse(await readFile(join(dir, "recovery.json"), "utf8")))
  })

for (const terminal of [false, true])
  test(`memory-only EIO containment never deletes even when terminal=${terminal}`, async (t) => {
    const { store } = await seeded(t)
    const reads = []
    const { deps, calls } = dependencies(store, {
      readSession: async (id) => {
        reads.push(id)
        return terminal ? ended : active
      },
    })
    await runner.containFromMemory(store, deps)
    assert.equal(calls.filter(([name]) => name === "deleteProbe").length, 0)
    assert.ok(calls.some(([name]) => name === "readProbe"))
    assert.deepEqual(reads, [identity.sessionId])
    assert.equal(
      calls.filter(([name]) => name === "stopSession").length,
      terminal ? 0 : 1
    )
  })

test("private inventory accepts opaque IDs and sorts without reading secret values", () => {
  const entries = [
    { id: "key-b", type: "private" },
    { id: "key-a", type: "private" },
  ]
  for (const entry of entries)
    Object.defineProperty(entry, "value", {
      get() {
        throw new Error("must_not_read_credential")
      },
    })
  assert.deepEqual(runner.privateKeyInventory({ body: { private: entries } }), [
    "key-a",
    "key-b",
  ])
})

for (const inventory of [
  undefined,
  {},
  { private: null },
  { private: [{}] },
  { private: [{ id: " ", type: "private" }] },
  { private: [{ id: "key", type: "public" }] },
  {
    private: [
      { id: "key", type: "private" },
      { id: "key", type: "private" },
    ],
  },
])
  test(`malformed private inventory fails closed: ${JSON.stringify(inventory)}`, () => {
    assert.throws(
      () => runner.privateKeyInventory(inventory),
      /private_key_inventory_invalid/u
    )
  })

for (const change of [
  "same",
  "addition",
  "removal",
  "malformed",
  "missing-baseline",
])
  test(`persisted private inventory ${change} controls cleanup ownership`, async (t) => {
    const { store } = await seeded(t)
    await store.checkpoint((state) => {
      state.privateKeyIds = ["opaque-management-key"]
    })
    if (change === "missing-baseline")
      await store.checkpoint((state) => {
        delete state.privateKeyIds
      })
    const ids =
      change === "addition"
        ? ["opaque-management-key", "new-key"]
        : change === "removal"
          ? []
          : ["opaque-management-key"]
    const keys =
      change === "malformed"
        ? { body: {} }
        : { body: { private: ids.map((id) => ({ id, type: "private" })) } }
    const { deps, calls } = dependencies(store)
    const readProbe = deps.readProbe
    const readProduction = deps.readProduction
    deps.readProbe = async () => ({ ...(await readProbe()), keys })
    deps.readProduction = async () => ({ ...(await readProduction()), keys })
    const complete = await runner.cleanupRun(store, deps)
    assert.equal(complete, change === "same")
    assert.equal(
      calls.filter(([name]) => name === "deleteProbe").length,
      change === "same" ? 1 : 0
    )
  })

for (const field of [
  "serviceName",
  "organizationId",
  "serviceId",
  "deploymentId",
])
  test(`private session operations reject invalid retained scope ${field} before HTTP`, async (t) => {
    const args = request()
    if (field === "serviceName") args.recovery.serviceName = "duplexd-agent"
    else if (field === "organizationId")
      args.recovery.organizationId = "not-an-organization-uuid"
    else args.recovery.probe[field] = "not-a-scope-uuid"
    let calls = 0
    t.mock.method(globalThis, "fetch", async () => {
      calls++
      throw new Error("unexpected_request")
    })
    for (const invoke of [
      runner.readExactSession,
      runner.stopExactSession,
      runner.readActiveSessions,
    ])
      await assert.rejects(invoke(args), /ownership_unresolved/u)
    assert.equal(calls, 0)
  })

for (const error of ["provider_http_404", "provider_network_failure"])
  test(`cached terminal resources cannot authorize deletion after current read fails with ${error}`, async (t) => {
    const { store, ref } = await seeded(t)
    await store.checkpoint((state) =>
      Object.assign(
        state.sessions[ref],
        runner.normalizeSessionObservation(ended),
        { readbackValid: true }
      )
    )
    const { deps, calls } = dependencies(store, {
      readSession: async () => {
        throw new Error(error)
      },
    })
    assert.equal(await runner.cleanupRun(store, deps), false)
    assert.equal(calls.filter(([name]) => name === "deleteProbe").length, 0)
    assert.equal(store.recovery.sessions[ref].readbackValid, false)
  })

test("resource completion cannot pass beyond provider runtime bound even when accounting is unknown", () => {
  const observation = runner.normalizeSessionObservation(ended)
  observation.observedRuntimeMinutes = 11
  assert.throws(
    () =>
      runner.assertCaseComplete({ sessions: { exact: observation } }, "exact"),
    /session_resource_bound_exceeded/u
  )
})

test("recover without private key refuses before opening durable state or issuing provider operations", async (t) => {
  const { store, dir } = await seeded(t)
  await store.close()
  const files = ["events.ndjson", "recovery.json"]
  const before = await Promise.all(
    files.map((file) => readFile(join(dir, file), "utf8"))
  )
  const child = fixtureChild(t, "signal-process.mjs", [
    dir,
    "missing-private-key-recover",
  ])
  const boundaries = await child.message("boundaries")
  assert.equal((await child.exited)[0], 1)
  assert.equal(boundaries.starts, 0)
  assert.deepEqual(boundaries.calls, [])
  assert.deepEqual(
    await Promise.all(files.map((file) => readFile(join(dir, file), "utf8"))),
    before
  )
})
