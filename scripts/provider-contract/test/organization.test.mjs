import assert from "node:assert/strict"
import { readFile, access } from "node:fs/promises"
import { join } from "node:path"
import { test } from "node:test"
import { DurableRunStore } from "../run.mjs"
import { identity, seed } from "./fixtures/state.mjs"
import { fixtureChild, runDirectory } from "./fixtures/test-support.mjs"

const namespace = "fixture-namespace"
const organizationId = "22222222-2222-4222-8222-222222222222"
async function checkpoint(dir) {
  return JSON.parse(await readFile(join(dir, "recovery.json"), "utf8"))
}
function assertNamespace(calls) {
  const control = calls.filter(
    ([type, , path]) => type === "http" && path.startsWith("/v1/organizations/")
  )
  assert.ok(control.length > 0)
  assert.ok(
    control.every(([, , path]) =>
      path.startsWith(`/v1/organizations/${namespace}/`)
    )
  )
  const commands = calls.filter(([type]) => type === "command")
  assert.ok(commands.length > 0)
  for (const call of commands)
    assert.equal(call[call.indexOf("--organization") + 1], namespace)
}
async function assertSanitized(dir) {
  for (const file of ["events.ndjson", "summary.json"]) {
    const text = await readFile(join(dir, file), "utf8")
    assert.equal(text.includes(namespace), false)
    assert.equal(text.includes(organizationId), false)
  }
}

test("live resolves namespace before effects, preserves control namespace and binds private UUID", async (t) => {
  const dir = await runDirectory(t)
  const child = fixtureChild(t, "signal-process.mjs", [dir, "complete-case"])
  const result = await child.message("boundaries", 8000)
  assert.equal((await child.exited)[0], 0)
  assert.deepEqual(result.calls[0], ["http", "GET", "/v1/organizations"])
  assert.equal(result.starts, 6)
  assertNamespace(result.calls)
  const state = await checkpoint(dir)
  assert.equal(state.organization, namespace)
  assert.equal(state.organizationId, organizationId)
  await assertSanitized(dir)
})

for (const reason of ["missing", "ambiguous", "malformed"])
  test(`live rejects ${reason} namespace mapping before run setup or provider/process effects`, async (t) => {
    const dir = await runDirectory(t)
    const child = fixtureChild(t, "signal-process.mjs", [
      dir,
      `organization-${reason}`,
    ])
    const result = await child.message("boundaries")
    assert.equal((await child.exited)[0], 1)
    assert.deepEqual(result.calls, [["http", "GET", "/v1/organizations"]])
    assert.equal(result.starts, 0)
    await assert.rejects(access(dir), { code: "ENOENT" })
  })

for (const condition of [
  "valid",
  "wrong-name",
  "wrong-uuid",
  "legacy",
  "missing",
  "ambiguous",
  "malformed",
])
  test(`recover independently binds namespace/UUID: ${condition}`, async (t) => {
    const dir = await runDirectory(t)
    const store = await DurableRunStore.create(dir, {
      ...identity,
      organization: namespace,
      organizationId,
    })
    await seed(store)
    await store.checkpoint((state) => {
      state.probe.buildId = "11111111-2222-4333-8444-555555555555"
      state.probe.deploymentId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
      if (condition === "legacy") delete state.organizationId
    })
    await store.close()
    const before = await checkpoint(dir)
    const child = fixtureChild(t, "signal-process.mjs", [
      dir,
      `organization-recover-${condition}`,
    ])
    const result = await child.message("boundaries")
    await child.exited
    assert.equal(result.starts, 0)
    assert.deepEqual(result.calls[0], ["http", "GET", "/v1/organizations"])
    if (condition === "valid") {
      assertNamespace(result.calls)
      assert.ok(
        result.calls.some(
          ([kind, method, path]) =>
            kind === "http" &&
            method === "GET" &&
            path.startsWith("/v1/agents/")
        )
      )
      assert.ok(
        result.calls.some(
          (call) => call[0] === "command" && call.includes("delete")
        )
      )
      await assertSanitized(dir)
    } else
      assert.deepEqual(result.calls, [["http", "GET", "/v1/organizations"]])
    const after = await checkpoint(dir)
    assert.equal(after.organization, before.organization)
    assert.equal(after.organizationId, before.organizationId)
  })
