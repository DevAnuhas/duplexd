import { randomBytes, randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { CallsList } from "@/app/(app)/calls/calls-list"
import { STARTING_STALE_AFTER_MS } from "@/control/constants"
import { createAssistant } from "@/data/assistants"
import {
  getWorkspaceCallForAccount,
  listWorkspaceCallsForAccount,
  type SandboxModeFilter,
  type WorkspaceCall,
  type WorkspaceSourceFilter,
} from "@/data/calls"
import { closeDb, getDb } from "@/db/client"
import { calls, practiceInvocations } from "@/db/schema"
import { getSandboxEventPage } from "@/sandbox/evidence"
import type { SandboxCompletion, SandboxEvent } from "@/sandbox/protocol"
import { signUpNewAccount } from "./helpers/auth.ts"
import { isDatabaseConfigured } from "./helpers/environment.ts"
import { sandboxFixture } from "./helpers/sandbox.ts"

/**
 * #65: the account-scoped Calls reads over a Sandbox call.
 *
 * Three rules, each of which the pre-#65 read broke or did not have:
 *
 *  1. Integration's stale transition does not describe a Sandbox call. The
 *     sweeper cutoffs are about an Integration agent that never reported; a
 *     Sandbox call is owned by its attempt lifecycle, and a read that rewrote
 *     it to `failed / agent_never_started` wrote an ending nobody observed.
 *  2. The list and detail carry the Sandbox evidence state, derived from the
 *     same ledger the live poll ACKs from, and `null` for Integration.
 *  3. The detail's review events are the live poll's events minus the cursor,
 *     enriched from this call's own sample selection and nothing else.
 */

type Fixture = Awaited<ReturnType<typeof sandboxFixture>>

const AT = "2026-09-22T00:00:00.000Z"

function event(
  seq: number,
  type = "interruption",
  payload: Record<string, unknown> = {}
): SandboxEvent {
  return { seq, at: AT, type, payload }
}

const completion: SandboxCompletion = {
  endedReason: "client_disconnected",
  durationSecs: 2.5,
  finalSeq: 2,
  producerLoss: false,
  truncated: false,
}

/** Long enough past the starting cutoff that no clock skew can rescue it. */
const LONG_AGO = () => new Date(Date.now() - STARTING_STALE_AFTER_MS * 10)

/** An Integration call row in the fixture's account, shaped like `createCall` writes. */
async function integrationCall(
  accountId: string,
  values: Partial<typeof calls.$inferInsert>
): Promise<string> {
  const id = `call_${randomUUID()}`
  await getDb()
    .insert(calls)
    .values({
      id,
      accountId,
      assistantSnapshot: {},
      source: "integration",
      state: "starting",
      ...values,
    })
  return id
}

async function detail(accountId: string, callId: string) {
  const found = await getWorkspaceCallForAccount(accountId, callId)
  if (found === null) throw new Error(`call ${callId} not visible`)
  return found
}

async function listed(accountId: string): Promise<Map<string, WorkspaceCall>> {
  const page = await listWorkspaceCallsForAccount(accountId, { limit: 100 })
  if (page.kind !== "ok") throw new Error(page.kind)
  return new Map(page.calls.map((call) => [call.id, call]))
}

async function selectSample(
  callId: string,
  invocationId: string,
  scenario: string,
  statusCode: number,
  responseBody: unknown = null
) {
  await getDb()
    .insert(practiceInvocations)
    .values({
      callId,
      invocationId,
      requestDigest: `digest-${invocationId}`,
      toolName: "synthetic",
      scenario,
      statusCode,
      responseBody,
      readyAt: new Date(),
    })
}

afterAll(closeDb)

const describeDatabase = describe.skipIf(!isDatabaseConfigured())

describeDatabase("a Sandbox call past Integration's stale cutoffs", () => {
  /**
   * The control is the half that makes this discriminating: the same stored
   * state and age on an Integration row in the same account still projects
   * the sweeper's ending, so the difference is the source and nothing else.
   */
  it("still reads as starting on the list and detail, while Integration fails", async () => {
    const f = await sandboxFixture()
    const accountId = f.account.accountId
    const sandboxId = f.agent.callId
    await getDb()
      .update(calls)
      .set({ state: "starting", createdAt: LONG_AGO(), lastHeartbeatAt: null })
      .where(eq(calls.id, sandboxId))
    const integrationId = await integrationCall(accountId, {
      state: "starting",
      createdAt: LONG_AGO(),
    })

    const rows = await listed(accountId)
    for (const call of [
      rows.get(sandboxId)!,
      (await detail(accountId, sandboxId)).call,
    ]) {
      expect(call).toMatchObject({
        source: "sandbox",
        state: "starting",
        endedReason: null,
      })
    }
    for (const call of [
      rows.get(integrationId)!,
      (await detail(accountId, integrationId)).call,
    ]) {
      expect(call).toMatchObject({
        source: "integration",
        state: "failed",
        endedReason: "agent_never_started",
      })
    }

    // A read is a projection: neither row was written by it.
    const stored = await getDb()
      .select({ id: calls.id, state: calls.state })
      .from(calls)
      .where(eq(calls.accountId, accountId))
    expect(new Map(stored.map((row) => [row.id, row.state]))).toStrictEqual(
      new Map([
        [sandboxId, "starting"],
        [integrationId, "starting"],
      ])
    )
  })

  it("still reads as active with a stale heartbeat, while Integration goes incomplete", async () => {
    const f = await sandboxFixture()
    const accountId = f.account.accountId
    await getDb()
      .update(calls)
      .set({ state: "active", lastHeartbeatAt: LONG_AGO() })
      .where(eq(calls.id, f.agent.callId))
    const integrationId = await integrationCall(accountId, {
      state: "active",
      lastHeartbeatAt: LONG_AGO(),
    })

    const rows = await listed(accountId)
    expect(rows.get(f.agent.callId)).toMatchObject({
      state: "active",
      endedReason: null,
    })
    expect(rows.get(integrationId)).toMatchObject({
      state: "incomplete",
      endedReason: "agent_lost",
    })
  })
})

describeDatabase("the evidence state on the Calls reads", () => {
  /**
   * Walked through the real ingest and seal, so the durable read is compared
   * against the ACK the agent was actually given at each step rather than
   * against a hand-set ledger that might not be reachable.
   */
  it("tracks the live ACK from unknown through partial to complete", async () => {
    const f = await sandboxFixture()
    const accountId = f.account.accountId
    const callId = f.agent.callId

    async function evidenceOn() {
      const fromDetail = (await detail(accountId, callId)).call.evidence
      const fromList = (await listed(accountId)).get(callId)!.evidence
      expect(fromList).toStrictEqual(fromDetail)
      return fromDetail
    }

    const gap = await f.evidence.ingest(f.agent, [event(2)])
    expect(gap).toMatchObject({ kind: "ok", ack: { evidenceState: "unknown" } })
    expect(await evidenceOn()).toStrictEqual({
      state: "unknown",
      finalSeq: null,
      contiguousSeq: 0,
      producerLoss: false,
      truncated: false,
      integrityConflict: false,
      reconciled: false,
    })

    const sealed = await f.evidence.complete(f.agent, completion)
    expect(sealed).toMatchObject({
      kind: "ok",
      ack: { evidenceState: "partial" },
    })
    expect(await evidenceOn()).toMatchObject({
      state: "partial",
      finalSeq: 2,
      contiguousSeq: 0,
    })

    const filled = await f.evidence.ingest(f.agent, [event(1, "agent_ready")])
    expect(filled).toMatchObject({
      kind: "ok",
      ack: { evidenceState: "complete" },
    })
    expect(await evidenceOn()).toMatchObject({
      state: "complete",
      finalSeq: 2,
      contiguousSeq: 2,
      reconciled: true,
    })

    const page = await getSandboxEventPage(accountId, callId, null)
    if (!page || page === "invalid_cursor") throw new Error("missing page")
    expect(page.evidence).toStrictEqual(await evidenceOn())
  })

  it("is partial on a sealed call whose producer reported loss", async () => {
    const f = await sandboxFixture()
    await f.evidence.ingest(f.agent, [event(1), event(2)])
    await f.evidence.complete(f.agent, { ...completion, producerLoss: true })

    expect(
      (await detail(f.account.accountId, f.agent.callId)).call.evidence
    ).toMatchObject({ state: "partial", contiguousSeq: 2, producerLoss: true })
  })

  /**
   * Integration has no Sandbox ledger, and "not tracked" is not "unknown".
   * An Integration row that happened to carry evidence fields would be
   * claiming a guarantee the Integration path never makes.
   */
  it("is null for Integration on both reads", async () => {
    const f = await sandboxFixture()
    const integrationId = await integrationCall(f.account.accountId, {
      state: "ended",
      endedReason: "client_disconnected",
    })

    expect(
      (await detail(f.account.accountId, integrationId)).call.evidence
    ).toBeNull()
    expect(
      (await listed(f.account.accountId)).get(integrationId)!.evidence
    ).toBeNull()
    expect(
      (await listed(f.account.accountId)).get(f.agent.callId)!.evidence
    ).not.toBeNull()
  })
})

describeDatabase("the review events on the Calls detail", () => {
  const RAW = "raw-payload-canary-2b9e"
  const BODY = "sample-response-body-canary-a41f"

  async function toolCall(f: Fixture, invocationId: string, seq: number) {
    await f.evidence.ingest(f.agent, [
      event(seq, "tool_finished", {
        tool: "synthetic",
        invocationId,
        outcome: "failure",
        durationMs: 10,
        arguments: { secret: RAW },
        result: RAW,
        serverSecret: RAW,
      }),
    ])
  }

  it("matches the live poll event for event, minus only the cursor", async () => {
    const f = await sandboxFixture()
    await f.evidence.ingest(f.agent, [
      event(1, "transcript_user", { text: "synthetic question" }),
      event(2, "tool_started", { tool: "synthetic", invocationId: "inv-1" }),
    ])
    await toolCall(f, "inv-1", 3)
    await selectSample(f.agent.callId, "inv-1", "failure", 503, { body: BODY })

    const page = await getSandboxEventPage(
      f.account.accountId,
      f.agent.callId,
      null
    )
    if (!page || page === "invalid_cursor") throw new Error("missing page")
    const { reviewEvents, events } = await detail(
      f.account.accountId,
      f.agent.callId
    )

    expect(page.events.every((e) => typeof e.cursor === "string")).toBe(true)
    expect(reviewEvents).toStrictEqual(
      page.events.map((e) => {
        const rest: Partial<typeof e> = { ...e }
        delete rest.cursor
        return rest
      })
    )
    expect(reviewEvents.find((e) => e.seq === 3)!.payload).toStrictEqual({
      tool: "synthetic",
      invocationId: "inv-1",
      outcome: "failure",
      durationMs: 10,
      practiceScenario: "failure",
      practiceSelectedStatus: 503,
    })
    // The base projection the page already renders is left unenriched.
    expect(events.find((e) => e.seq === 3)!.payload).not.toHaveProperty(
      "practiceScenario"
    )
    const serialized = JSON.stringify({ reviewEvents, events, page })
    expect(serialized).not.toContain(RAW)
    expect(serialized).not.toContain(BODY)
  })

  /**
   * Invocation ids are chosen by the agent and are only unique within a call.
   * Another call — in another account — selecting a different sample under the
   * same id must not colour this call's card.
   */
  it("enriches from this call's selection only, never another call's with the same id", async () => {
    const mine = await sandboxFixture()
    const theirs = await sandboxFixture()
    await toolCall(mine, "shared-id", 1)
    await toolCall(theirs, "shared-id", 1)
    await selectSample(theirs.agent.callId, "shared-id", "slow", 200)

    const { reviewEvents } = await detail(
      mine.account.accountId,
      mine.agent.callId
    )
    expect(reviewEvents[0]!.payload).not.toHaveProperty("practiceScenario")
    expect(reviewEvents[0]!.payload).not.toHaveProperty(
      "practiceSelectedStatus"
    )

    // Same account, different call: the account join cannot mask this one,
    // so only the call scope on the selection query keeps it out.
    const sibling = await integrationCall(mine.account.accountId, {
      state: "ended",
    })
    await selectSample(sibling, "shared-id", "slow", 201)
    const sameAccount = await detail(mine.account.accountId, mine.agent.callId)
    expect(sameAccount.reviewEvents[0]!.payload).not.toHaveProperty(
      "practiceScenario"
    )
    expect(sameAccount.reviewEvents[0]!.payload).not.toHaveProperty(
      "practiceSelectedStatus"
    )
    // The live poll has no account join at all; its call scope is the guard.
    const live = await getSandboxEventPage(
      mine.account.accountId,
      mine.agent.callId,
      null
    )
    if (!live || live === "invalid_cursor") throw new Error("missing page")
    expect(live.events[0]!.payload).not.toHaveProperty("practiceScenario")
    expect(live.events[0]!.payload).not.toHaveProperty("practiceSelectedStatus")

    await selectSample(mine.agent.callId, "shared-id", "failure", 502)
    const again = await detail(mine.account.accountId, mine.agent.callId)
    expect(again.reviewEvents[0]!.payload).toMatchObject({
      practiceScenario: "failure",
      practiceSelectedStatus: 502,
    })
  })

  it("is invisible to another account", async () => {
    const mine = await sandboxFixture()
    const other = await sandboxFixture()
    await toolCall(mine, "inv-1", 1)

    expect(
      await getWorkspaceCallForAccount(
        other.account.accountId,
        mine.agent.callId
      )
    ).toBeNull()
  })
})

/**
 * #65 filters on the account Calls list: source (all / sandbox / integration)
 * and Sandbox mode (all / practice), composed with the assistant scope and the
 * keyset cursor.
 *
 * The seed is written so that every filter excludes something the one before
 * it kept — a Sandbox row with no test mode, an Integration row on the same
 * assistant, a second assistant, a second account on the very same
 * timestamps — and several rows share a `createdAt`, so page boundaries fall
 * inside a tie and only the `(createdAt, id)` tiebreak keeps the walk exact.
 * Each walk is compared, in order, to the model of what was inserted.
 */
describeDatabase("the Calls list filters", () => {
  type Seeded = {
    id: string
    accountId: string
    assistantId: string | null
    source: "sandbox" | "integration"
    testMode: string | null
    createdAt: Date
  }
  type Filter = {
    source?: WorkspaceSourceFilter
    mode?: SandboxModeFilter
    assistant?: "x" | "y"
  }

  const T = [0, 1, 2, 3].map(
    (step) => new Date(Date.UTC(2026, 0, 1, 0, 0, step))
  )
  const seeded: Seeded[] = []
  let A = ""
  let B = ""
  const assistantsOf: Record<string, string> = {}

  async function assistantIn(accountId: string, name: string) {
    const created = await createAssistant(accountId, {
      name: `${name} ${randomUUID()}`,
      voice: "marin",
      accentStyle: "Neutral.",
      instructions: "Synthetic data only.",
      backendInstructions: "Answer briefly.",
      backendModel: "gpt-5.6-luna",
      waitingBehavior: "Acknowledge once.",
      tools: [],
    })
    return created.id
  }

  async function seed(row: Omit<Seeded, "id">) {
    // Lowercase hex of one length sorts the same under C and en_US
    // collation, so the model's order is the database's order.
    const id = randomBytes(12).toString("hex")
    await getDb().insert(calls).values({
      id,
      accountId: row.accountId,
      assistantId: row.assistantId,
      assistantSnapshot: {},
      source: row.source,
      testMode: row.testMode,
      state: "ended",
      endedReason: "client_disconnected",
      createdAt: row.createdAt,
    })
    seeded.push({ id, ...row })
  }

  beforeAll(async () => {
    A = (await signUpNewAccount()).accountId
    B = (await signUpNewAccount()).accountId
    assistantsOf.x = await assistantIn(A, "Filter X")
    assistantsOf.y = await assistantIn(A, "Filter Y")
    assistantsOf.z = await assistantIn(B, "Filter Z")
    const { x, y, z } = assistantsOf
    const sandbox = { source: "sandbox" as const, testMode: "practice" }
    // A future Sandbox mode, synthetic: today every Sandbox call is Practice,
    // which would make `mode=practice` indistinguishable from `source=sandbox`.
    const otherMode = { source: "sandbox" as const, testMode: null }
    const integration = { source: "integration" as const, testMode: null }
    const plan: Array<
      [
        number,
        string | null,
        typeof sandbox | typeof otherMode | typeof integration,
      ]
    > = [
      [0, x!, sandbox],
      [0, x!, integration],
      [0, x!, otherMode],
      [1, x!, integration],
      [1, y!, sandbox],
      [1, y!, integration],
      [2, x!, sandbox],
      [2, x!, sandbox],
      [2, null, integration],
      [3, y!, otherMode],
      [3, x!, integration],
      [3, x!, sandbox],
    ]
    for (const [step, assistantId, kind] of plan) {
      await seed({ accountId: A, assistantId, createdAt: T[step]!, ...kind })
    }
    // Account B on the same instants, so a leaked row would sit inside A's
    // ties rather than conveniently at an edge.
    for (const createdAt of T) {
      await seed({ accountId: B, assistantId: z!, createdAt, ...sandbox })
      await seed({ accountId: B, assistantId: z!, createdAt, ...integration })
    }
  })

  function expected(accountId: string, filter: Filter): string[] {
    const assistantId =
      filter.assistant === undefined
        ? undefined
        : assistantsOf[filter.assistant]
    return seeded
      .filter((row) => row.accountId === accountId)
      .filter(
        (row) => assistantId === undefined || row.assistantId === assistantId
      )
      .filter(
        (row) =>
          filter.source === undefined ||
          filter.source === "all" ||
          row.source === filter.source
      )
      .filter(
        (row) => filter.mode !== "practice" || row.testMode === "practice"
      )
      .sort(
        (a, b) =>
          b.createdAt.getTime() - a.createdAt.getTime() ||
          (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
      )
      .map((row) => row.id)
  }

  async function walk(
    accountId: string,
    filter: Filter & { assistantId?: string },
    limit: number
  ) {
    const ids: string[] = []
    const cursors: string[] = []
    let cursor: string | null = null
    for (let pages = 0; pages < 50; pages++) {
      const page = await listWorkspaceCallsForAccount(accountId, {
        cursor,
        limit,
        source: filter.source,
        mode: filter.mode,
        assistantId:
          filter.assistantId ??
          (filter.assistant === undefined
            ? undefined
            : assistantsOf[filter.assistant]),
      })
      if (page.kind !== "ok") throw new Error(page.kind)
      expect(page.calls.length).toBeLessThanOrEqual(limit)
      ids.push(...page.calls.map((call) => call.id))
      if (page.nextCursor === null) return { ids, cursors }
      cursors.push(page.nextCursor)
      cursor = page.nextCursor
    }
    throw new Error("pagination did not terminate")
  }

  const FILTERS: Filter[] = [
    {},
    { source: "all", mode: "all" },
    { source: "sandbox" },
    { source: "sandbox", mode: "practice" },
    { source: "integration" },
    { source: "all", mode: "practice" },
    { assistant: "x" },
    { assistant: "x", source: "sandbox" },
    { assistant: "x", source: "sandbox", mode: "practice" },
    { assistant: "x", source: "integration" },
    { assistant: "y", source: "sandbox" },
    { assistant: "y", source: "sandbox", mode: "practice" },
  ]

  it("seeds a model where every filter keeps a different set", () => {
    // The vacuity guard: if two filters expected the same rows, a filter that
    // was silently ignored could pass by matching its neighbour. Two pairs
    // are aliases by definition and are excluded: `all/all` is `{}`, and
    // `all/practice` is `sandbox/practice` because only Sandbox has a mode.
    const aliases = (f: Filter) => f.source === "all"
    const sets = FILTERS.filter((f) => !aliases(f)).map((f) =>
      expected(A, f).join(",")
    )
    expect(new Set(sets).size).toBe(sets.length)
    expect(expected(A, { source: "all", mode: "practice" })).toStrictEqual(
      expected(A, { source: "sandbox", mode: "practice" })
    )
    expect(expected(A, {})).toHaveLength(12)
    expect(expected(A, { source: "sandbox" })).toHaveLength(7)
    expect(expected(A, { source: "sandbox", mode: "practice" })).toHaveLength(5)
    expect(expected(A, { source: "integration" })).toHaveLength(5)
  })

  it.each(
    FILTERS.flatMap((filter) =>
      [1, 2, 5].map((limit) => [filter, limit] as const)
    )
  )("walks %j exactly, in order, at page size %i", async (filter, limit) => {
    const { ids } = await walk(A, filter, limit)
    expect(new Set(ids).size, "a row appeared on two pages").toBe(ids.length)
    expect(ids).toStrictEqual(expected(A, filter))
  })

  it("returns only rows of the requested source and mode on every page", async () => {
    const page = await listWorkspaceCallsForAccount(A, {
      source: "sandbox",
      mode: "practice",
      limit: 100,
    })
    if (page.kind !== "ok") throw new Error(page.kind)
    expect(
      page.calls.every(
        (call) => call.source === "sandbox" && call.testMode === "practice"
      )
    ).toBe(true)
    // Integration reads stay "not tracked"; Sandbox reads carry a ledger.
    const integration = await listWorkspaceCallsForAccount(A, {
      source: "integration",
      limit: 100,
    })
    if (integration.kind !== "ok") throw new Error(integration.kind)
    expect(integration.calls.every((call) => call.evidence === null)).toBe(true)
    expect(page.calls.every((call) => call.evidence !== null)).toBe(true)
  })

  it("keeps account scope when the assistant id belongs to another account", async () => {
    for (const filter of [
      {},
      { source: "sandbox" as const },
      { source: "integration" as const },
    ]) {
      expect(
        (await walk(A, { ...filter, assistantId: assistantsOf.z }, 2)).ids
      ).toStrictEqual([])
      expect(
        (await walk(B, { ...filter, assistantId: assistantsOf.x }, 2)).ids
      ).toStrictEqual([])
    }
  })

  /**
   * A cursor is a position, not a grant. Replaying account B's cursor —
   * minted on the same timestamps — against account A must yield A's rows
   * after that position and never one of B's.
   */
  it("keeps account scope when replaying another account's cursor", async () => {
    const theirs = await walk(B, { source: "sandbox" }, 1)
    expect(theirs.cursors.length).toBeGreaterThan(1)
    const mine = new Set(expected(A, {}))
    for (const cursor of theirs.cursors) {
      for (const source of ["all", "sandbox", "integration"] as const) {
        const page = await listWorkspaceCallsForAccount(A, {
          cursor,
          source,
          limit: 100,
        })
        if (page.kind !== "ok") throw new Error(page.kind)
        for (const call of page.calls) expect(mine.has(call.id)).toBe(true)
      }
    }
  })

  it("keeps rejecting a malformed cursor under every filter", async () => {
    for (const filter of FILTERS) {
      expect(
        await listWorkspaceCallsForAccount(A, {
          cursor: "not-a-cursor",
          source: filter.source,
          mode: filter.mode,
        })
      ).toStrictEqual({ kind: "invalid_cursor" })
    }
  })
})

/**
 * The filter links the Calls list renders. Pure markup, no database, so this
 * runs on every machine. The rules: switching filters starts from the newest
 * page (a cursor from one filter is a position in a different list), while
 * "Older calls" keeps the active filter; Practice mode is only offered, and
 * only reachable, from within Sandbox; and the assistant-scoped list keeps its
 * own base path.
 */
describe("the Calls filter links", () => {
  function links(
    source: WorkspaceSourceFilter,
    mode: SandboxModeFilter,
    options: {
      nextCursor?: string | null
      basePath?: string
      assistantName?: string
    } = {}
  ) {
    const html = renderToStaticMarkup(
      createElement(CallsList, {
        calls: [],
        nextCursor: options.nextCursor ?? null,
        basePath: options.basePath ?? "/calls",
        assistantName: options.assistantName,
        source,
        mode,
      })
    )
    const found = new Map<string, { href: string; current: boolean }>()
    for (const match of html.matchAll(/<a\b([^>]*)>([^<]*)<\/a>/g)) {
      const attrs = match[1]!
      const href = /href="([^"]*)"/.exec(attrs)?.[1]?.replaceAll("&amp;", "&")
      found.set(match[2]!, {
        href: href ?? "",
        current: /aria-current="page"/.test(attrs),
      })
    }
    return found
  }

  it("links each source from the unfiltered list and marks All current", () => {
    const found = links("all", "all")
    expect(found.get("All")).toStrictEqual({ href: "/calls", current: true })
    expect(found.get("Sandbox")).toStrictEqual({
      href: "/calls?source=sandbox",
      current: false,
    })
    expect(found.get("Integration")).toStrictEqual({
      href: "/calls?source=integration",
      current: false,
    })
    expect(found.has("Practice mode")).toBe(false)
  })

  it("offers Practice mode only inside Sandbox, and toggles it", () => {
    expect(links("integration", "all").has("Practice mode")).toBe(false)
    expect(links("sandbox", "all").get("Practice mode")).toStrictEqual({
      href: "/calls?source=sandbox&mode=practice",
      current: false,
    })
    expect(links("sandbox", "practice").get("Practice mode")).toStrictEqual({
      href: "/calls?source=sandbox",
      current: true,
    })
    expect(links("sandbox", "practice").get("Sandbox")).toStrictEqual({
      href: "/calls?source=sandbox",
      current: true,
    })
  })

  it("drops the cursor when switching filters but keeps the filter when paging", () => {
    const found = links("sandbox", "practice", { nextCursor: "c-opaque" })
    for (const label of ["All", "Sandbox", "Integration", "Practice mode"]) {
      expect(found.get(label)!.href).not.toContain("cursor")
    }
    expect(found.get("Older calls")!.href).toBe(
      "/calls?source=sandbox&mode=practice&cursor=c-opaque"
    )
    expect(
      links("all", "all", { nextCursor: "c-opaque" }).get("Older calls")!.href
    ).toBe("/calls?cursor=c-opaque")
  })

  it("keeps the assistant-scoped base path on every filter and paging link", () => {
    const basePath = "/assistants/asst_123/calls"
    // With a filter active, the empty state offers a way back to every call.
    const found = links("sandbox", "all", {
      basePath,
      nextCursor: "c",
      assistantName: "Synthetic assistant",
    })
    const labels = ["All", "Sandbox", "Integration", "Practice mode"]
    for (const label of [...labels, "Older calls"]) {
      expect(found.get(label)?.href.startsWith(`${basePath}`), label).toBe(true)
    }
    expect(found.get("Integration")!.href).toBe(
      `${basePath}?source=integration`
    )
    expect(found.get("Practice mode")!.href).toBe(
      `${basePath}?source=sandbox&mode=practice`
    )
    expect(found.get("Older calls")!.href).toBe(
      `${basePath}?source=sandbox&cursor=c`
    )
    expect(found.get("View all calls")!.href).toBe(basePath)
  })
})
