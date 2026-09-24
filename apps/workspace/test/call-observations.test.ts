import { randomUUID } from "node:crypto"

import { asc, eq } from "drizzle-orm"
import { afterAll, describe, expect, it } from "vitest"

import {
  getCallObservationsForAccount,
  parseObservationInput,
  putCallObservation,
  type Observation,
  type ObservationInput,
} from "@/data/observations"
import { closeDb, getDb } from "@/db/client"
import {
  callEvents,
  callObservations,
  calls,
  sandboxEvidence,
  users,
} from "@/db/schema"
import type { SandboxCompletion, SandboxEvent } from "@/sandbox/protocol"
import { signUpNewAccount, type SignedUpUser } from "./helpers/auth.ts"
import { isDatabaseConfigured } from "./helpers/environment.ts"
import { sandboxFixture } from "./helpers/sandbox.ts"

/**
 * #65: human observations on a finished Sandbox call.
 *
 * An observation is a tester's assertion about what they heard. It is not
 * runtime evidence and never becomes it, so the rules here are about who may
 * write which row and what a write may touch:
 *
 *  - reads are account-scoped; writes are author-scoped on top of that;
 *  - the first write is an insert that loses cleanly to a concurrent one, and
 *    every later write is a compare-and-swap on `revision`;
 *  - a stale write of your own row is a conflict that shows you the current
 *    row; anything else that fails is indistinguishable from "no such call";
 *  - only a terminal Sandbox call accepts one;
 *  - no write changes the call, its events or its evidence ledger.
 *
 * Every rejection here has an accepted control on the same fixture, so a test
 * passes because the rule under test fired, not because the fixture was broken.
 */

const AT = "2026-09-22T00:00:00.000Z"

const ANSWERS = {
  heardExpectedAnswer: "met",
  correctToolOutcome: "needs_work",
  honestFailureSpeech: "not_checked",
  acceptableInterruptionWaiting: "met",
} as const

const completion: SandboxCompletion = {
  endedReason: "client_disconnected",
  durationSecs: 2.5,
  finalSeq: 2,
  producerLoss: false,
  truncated: false,
}

function event(seq: number, type = "interruption"): SandboxEvent {
  return { seq, at: AT, type, payload: {} }
}

/** A validated input, built through the real parser so no test bypasses it. */
function observation(
  expectedRevision: number,
  overrides: Record<string, unknown> = {}
): ObservationInput {
  const parsed = parseObservationInput({
    expectedRevision,
    ...ANSWERS,
    note: "",
    ...overrides,
  })
  if (parsed === null) throw new Error("test input failed validation")
  return parsed
}

/** An ended Sandbox call, reached through the real evidence completion. */
async function endedSandboxCall() {
  const f = await sandboxFixture()
  await f.evidence.ingest(f.agent, [event(1, "agent_ready"), event(2)])
  expect(await f.evidence.complete(f.agent, completion)).toMatchObject({
    kind: "ok",
  })
  const [row] = await getDb()
    .select({ state: calls.state, source: calls.source })
    .from(calls)
    .where(eq(calls.id, f.agent.callId))
  expect(row).toStrictEqual({ state: "ended", source: "sandbox" })
  return f
}

/** A second user moved into `owner`'s account; Stage A has no invite path yet. */
async function colleagueOf(owner: SignedUpUser): Promise<SignedUpUser> {
  const colleague = await signUpNewAccount()
  await getDb()
    .update(users)
    .set({ accountId: owner.accountId })
    .where(eq(users.id, colleague.userId))
  return { ...colleague, accountId: owner.accountId }
}

async function integrationCall(
  accountId: string,
  state = "ended"
): Promise<string> {
  const id = `call_${randomUUID()}`
  await getDb()
    .insert(calls)
    .values({
      id,
      accountId,
      assistantSnapshot: {},
      source: "integration",
      state,
      endedReason: state === "ended" ? "client_disconnected" : null,
    })
  return id
}

async function storedRows(callId: string) {
  return getDb()
    .select()
    .from(callObservations)
    .where(eq(callObservations.callId, callId))
    .orderBy(asc(callObservations.createdAt))
}

async function read(
  account: SignedUpUser,
  callId: string
): Promise<Observation[]> {
  const found = await getCallObservationsForAccount(
    account.accountId,
    callId,
    account.userId
  )
  if (found === null) throw new Error(`call ${callId} not visible`)
  return found
}

async function save(
  account: SignedUpUser,
  callId: string,
  input: ObservationInput
) {
  return putCallObservation(account.accountId, account.userId, callId, input)
}

async function saved(
  account: SignedUpUser,
  callId: string,
  input: ObservationInput
): Promise<Observation> {
  const result = await save(account, callId, input)
  if (result.kind !== "saved") throw new Error(`expected saved: ${result.kind}`)
  return result.observation
}

/** Everything a runtime owner writes about a call, for a before/after diff. */
async function runtimeRecord(callId: string) {
  const db = getDb()
  const [call] = await db.select().from(calls).where(eq(calls.id, callId))
  const events = await db
    .select()
    .from(callEvents)
    .where(eq(callEvents.callId, callId))
    .orderBy(asc(callEvents.seq))
  const ledger = await db
    .select()
    .from(sandboxEvidence)
    .where(eq(sandboxEvidence.callId, callId))
  return { call, events, ledger }
}

const DTO_KEYS = [
  "acceptableInterruptionWaiting",
  "authorName",
  "checklistVersion",
  "correctToolOutcome",
  "createdAt",
  "heardExpectedAnswer",
  "honestFailureSpeech",
  "id",
  "isMine",
  "note",
  "revision",
  "updatedAt",
]

afterAll(closeDb)

describe("parseObservationInput", () => {
  const valid = { expectedRevision: 0, ...ANSWERS, note: "" }

  it("accepts a complete body and returns exactly the input fields", () => {
    expect(parseObservationInput(valid)).toStrictEqual(valid)
    expect(
      parseObservationInput({ ...valid, expectedRevision: 7, note: "ok" })
    ).toStrictEqual({ ...valid, expectedRevision: 7, note: "ok" })
  })

  it.each([
    ["null", null],
    ["an array", [valid]],
    ["a string", JSON.stringify(valid)],
    ["a number", 0],
  ])("rejects %s as the body", (_label, body) => {
    expect(parseObservationInput(body)).toBeNull()
  })

  it.each([
    ["missing", undefined],
    ["negative", -1],
    ["fractional", 1.5],
    ["a numeric string", "0"],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["beyond the safe range", 2 ** 53],
    ["null", null],
  ])("rejects an expectedRevision that is %s", (_label, expectedRevision) => {
    expect(parseObservationInput({ ...valid, expectedRevision })).toBeNull()
  })

  it.each(Object.keys(ANSWERS))(
    "rejects a missing, cased, foreign or null %s",
    (key) => {
      const without: Record<string, unknown> = { ...valid }
      delete without[key]
      expect(parseObservationInput(without)).toBeNull()
      for (const bad of ["MET", "passed", "", null, 1, true]) {
        expect(parseObservationInput({ ...valid, [key]: bad })).toBeNull()
      }
      for (const good of ["met", "needs_work", "not_checked"]) {
        expect(parseObservationInput({ ...valid, [key]: good })).not.toBeNull()
      }
    }
  )

  it("requires the note to be a string, and keeps an empty one as empty", () => {
    const without: Record<string, unknown> = { ...valid }
    delete without.note
    expect(parseObservationInput(without)).toBeNull()
    expect(parseObservationInput({ ...valid, note: null })).toBeNull()
    expect(parseObservationInput({ ...valid, note: 5 })).toBeNull()
    expect(parseObservationInput({ ...valid, note: ["x"] })).toBeNull()
    expect(parseObservationInput(valid)?.note).toBe("")
  })

  it.each([
    ["checklistVersion", 99],
    ["revision", 42],
    ["authorUserId", "user_forged"],
    ["accountId", "account_forged"],
    ["callId", "call_forged"],
    ["isMine", true],
    ["authorName", "Admin"],
    ["unexpected", "x"],
  ])("rejects a body that also carries %s", (key, value) => {
    expect(parseObservationInput({ ...valid, [key]: value })).toBeNull()
  })

  /**
   * The limit is Unicode code points after NFC. The astral case separates
   * code points from UTF-16 units (`String#length` would count it twice), and
   * the decomposed case separates "after NFC" from "before NFC".
   */
  describe("note length", () => {
    const astral = "\u{1F600}"

    it("accepts exactly 2,000 code points and rejects 2,001", () => {
      expect(
        parseObservationInput({ ...valid, note: "a".repeat(2_000) })
      ).not.toBeNull()
      expect(
        parseObservationInput({ ...valid, note: "a".repeat(2_001) })
      ).toBeNull()
    })

    it("counts an astral character once, not as two UTF-16 units", () => {
      const note = astral.repeat(2_000)
      expect(note.length).toBe(4_000)
      expect(parseObservationInput({ ...valid, note })?.note).toBe(note)
      expect(
        parseObservationInput({ ...valid, note: astral.repeat(2_001) })
      ).toBeNull()
    })

    it("counts after NFC and returns the composed form", () => {
      const decomposed = `${"a".repeat(1_999)}é`
      expect([...decomposed].length).toBe(2_001)
      const parsed = parseObservationInput({ ...valid, note: decomposed })
      expect(parsed?.note).toBe(`${"a".repeat(1_999)}é`)
      expect([...(parsed?.note ?? "")].length).toBe(2_000)
    })

    it("does not trim, so whitespace the tester typed survives", () => {
      expect(
        parseObservationInput({ ...valid, note: "  spaced \n" })?.note
      ).toBe("  spaced \n")
    })
  })

  describe("note characters", () => {
    it.each([
      ["newline", "line one\nline two"],
      ["tab", "col\tcol"],
      ["non-Latin text", "café ☕ 日本 مرحبا"],
    ])("accepts a %s", (_label, note) => {
      expect(parseObservationInput({ ...valid, note })?.note).toBe(note)
    })

    it.each([
      ["NUL", "\u0000"],
      ["BEL", "\u0007"],
      ["backspace", "\u0008"],
      ["vertical tab", "\u000b"],
      ["form feed", "\u000c"],
      ["carriage return", "\r"],
      ["escape", "\u001b"],
      ["unit separator", "\u001f"],
      ["DEL", "\u007f"],
      ["C1 PAD", "\u0080"],
      ["C1 NEL", "\u0085"],
      ["C1 APC", "\u009f"],
      ["LRE", "‪"],
      ["RLE", "‫"],
      ["PDF", "‬"],
      ["LRO", "‭"],
      ["RLO", "‮"],
      ["LRI", "⁦"],
      ["RLI", "⁧"],
      ["FSI", "⁨"],
      ["PDI", "⁩"],
      ["LRM", "‎"],
      ["RLM", "‏"],
      ["ALM", "؜"],
    ])("rejects %s anywhere in the note", (_label, character) => {
      for (const note of [
        character,
        `start${character}`,
        `mid${character}dle`,
        `${"a".repeat(1_000)}${character}`,
      ]) {
        expect(parseObservationInput({ ...valid, note })).toBeNull()
      }
    })
  })
})

const describeDatabase = describe.skipIf(!isDatabaseConfigured())

describeDatabase("first write and revision compare-and-swap", () => {
  it("inserts at revision 1 with the current checklist and marks it mine", async () => {
    const f = await endedSandboxCall()
    const result = await save(
      f.account,
      f.agent.callId,
      observation(0, { note: "Heard the answer." })
    )

    expect(result.kind).toBe("saved")
    if (result.kind !== "saved") return
    expect(Object.keys(result.observation).sort()).toStrictEqual(DTO_KEYS)
    expect(result.observation).toMatchObject({
      revision: 1,
      checklistVersion: 1,
      ...ANSWERS,
      note: "Heard the answer.",
      isMine: true,
    })
    expect(await read(f.account, f.agent.callId)).toStrictEqual([
      result.observation,
    ])
    const [row] = await storedRows(f.agent.callId)
    expect(row).toMatchObject({
      authorUserId: f.account.userId,
      revision: 1,
      checklistVersion: 1,
    })
  })

  it("updates only on the matching revision and moves it forward by one", async () => {
    const f = await endedSandboxCall()
    const first = await saved(f.account, f.agent.callId, observation(0))
    const second = await saved(
      f.account,
      f.agent.callId,
      observation(1, { heardExpectedAnswer: "needs_work", note: "Retried." })
    )

    expect(second).toMatchObject({
      id: first.id,
      revision: 2,
      heardExpectedAnswer: "needs_work",
      note: "Retried.",
      isMine: true,
    })
    expect(second.createdAt).toStrictEqual(first.createdAt)
    expect(second.updatedAt.getTime()).toBeGreaterThanOrEqual(
      first.updatedAt.getTime()
    )
    expect(await storedRows(f.agent.callId)).toHaveLength(1)
  })

  it("answers a stale update of my own row with the current row, and changes nothing", async () => {
    const f = await endedSandboxCall()
    await saved(f.account, f.agent.callId, observation(0, { note: "one" }))
    const current = await saved(
      f.account,
      f.agent.callId,
      observation(1, { note: "two" })
    )
    const before = await storedRows(f.agent.callId)

    const stale = await save(
      f.account,
      f.agent.callId,
      observation(1, { note: "lost update", correctToolOutcome: "met" })
    )

    expect(stale).toStrictEqual({ kind: "conflict", current })
    expect(await storedRows(f.agent.callId)).toStrictEqual(before)
  })

  it("treats a revision from the future as stale, not as a write", async () => {
    const f = await endedSandboxCall()
    const current = await saved(f.account, f.agent.callId, observation(0))
    const before = await storedRows(f.agent.callId)

    expect(
      await save(f.account, f.agent.callId, observation(5, { note: "x" }))
    ).toStrictEqual({ kind: "conflict", current })
    expect(await storedRows(f.agent.callId)).toStrictEqual(before)
  })

  it("answers a second first-write with the existing row instead of overwriting it", async () => {
    const f = await endedSandboxCall()
    const original = await saved(
      f.account,
      f.agent.callId,
      observation(0, { note: "original" })
    )
    const before = await storedRows(f.agent.callId)

    const again = await save(
      f.account,
      f.agent.callId,
      observation(0, { note: "clobber" })
    )

    expect(again).toStrictEqual({ kind: "conflict", current: original })
    expect(await storedRows(f.agent.callId)).toStrictEqual(before)
  })

  it("does not create a row for an update when I have none", async () => {
    const f = await endedSandboxCall()

    expect(await save(f.account, f.agent.callId, observation(1))).toStrictEqual(
      { kind: "not_found" }
    )
    expect(await storedRows(f.agent.callId)).toStrictEqual([])
    // Control: the same call accepts a first write.
    expect((await save(f.account, f.agent.callId, observation(0))).kind).toBe(
      "saved"
    )
  })

  /**
   * The race the insert-on-conflict shape exists for. Eight simultaneous first
   * writes must leave exactly one row and exactly one winner; every loser is a
   * conflict carrying the winner's row, never an error and never a second row.
   */
  it("lets exactly one of many concurrent first writes win", async () => {
    const f = await endedSandboxCall()
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        save(f.account, f.agent.callId, observation(0, { note: `w${index}` }))
      )
    )

    const winners = results.filter((result) => result.kind === "saved")
    const losers = results.filter((result) => result.kind === "conflict")
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(7)
    const rows = await storedRows(f.agent.callId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ revision: 1 })
    if (winners[0]?.kind !== "saved") throw new Error("no winner")
    expect(rows[0]!.note).toBe(winners[0].observation.note)
    for (const loser of losers) {
      if (loser.kind !== "conflict") throw new Error("not a conflict")
      expect(loser.current.id).toBe(rows[0]!.id)
    }
  })

  it("lets exactly one of many concurrent updates on one revision win", async () => {
    const f = await endedSandboxCall()
    await saved(f.account, f.agent.callId, observation(0))
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        save(f.account, f.agent.callId, observation(1, { note: `u${index}` }))
      )
    )

    expect(results.filter((result) => result.kind === "saved")).toHaveLength(1)
    expect(results.filter((result) => result.kind === "conflict")).toHaveLength(
      7
    )
    const [row] = await storedRows(f.agent.callId)
    expect(row).toMatchObject({ revision: 2 })
  })
})

describeDatabase("which calls accept an observation", () => {
  it("refuses a Sandbox call that has not finished, then accepts it once ended", async () => {
    const f = await sandboxFixture()
    const [running] = await getDb()
      .select({ state: calls.state })
      .from(calls)
      .where(eq(calls.id, f.agent.callId))
    expect(["starting", "active"]).toContain(running!.state)

    expect(await save(f.account, f.agent.callId, observation(0))).toStrictEqual(
      { kind: "not_found" }
    )
    expect(await storedRows(f.agent.callId)).toStrictEqual([])

    await f.evidence.ingest(f.agent, [event(1, "agent_ready"), event(2)])
    await f.evidence.complete(f.agent, completion)
    expect((await save(f.account, f.agent.callId, observation(0))).kind).toBe(
      "saved"
    )
  })

  it.each(["starting", "active"])(
    "refuses a Sandbox call stored as %s",
    async (state) => {
      const f = await endedSandboxCall()
      await getDb()
        .update(calls)
        .set({ state })
        .where(eq(calls.id, f.agent.callId))

      expect(
        await save(f.account, f.agent.callId, observation(0))
      ).toStrictEqual({ kind: "not_found" })
      expect(await storedRows(f.agent.callId)).toStrictEqual([])
    }
  )

  it.each(["ended", "incomplete", "failed"])(
    "accepts a Sandbox call stored as %s",
    async (state) => {
      const f = await endedSandboxCall()
      await getDb()
        .update(calls)
        .set({ state })
        .where(eq(calls.id, f.agent.callId))

      expect((await save(f.account, f.agent.callId, observation(0))).kind).toBe(
        "saved"
      )
    }
  )

  it("refuses a terminal preparation that never reached the voice agent", async () => {
    const f = await endedSandboxCall()
    await getDb()
      .update(calls)
      .set({
        state: "failed",
        startedAt: null,
        endedReason: "canceled_before_dispatch",
      })
      .where(eq(calls.id, f.agent.callId))

    expect(await save(f.account, f.agent.callId, observation(0))).toStrictEqual(
      {
        kind: "not_found",
      }
    )
    expect(await storedRows(f.agent.callId)).toStrictEqual([])
  })

  it("refuses an ended Integration call in the same account", async () => {
    const f = await endedSandboxCall()
    const integrationId = await integrationCall(f.account.accountId)

    expect(await save(f.account, integrationId, observation(0))).toStrictEqual({
      kind: "not_found",
    })
    expect(await storedRows(integrationId)).toStrictEqual([])
    // Control: same account, same user, a Sandbox call.
    expect((await save(f.account, f.agent.callId, observation(0))).kind).toBe(
      "saved"
    )
  })

  it("refuses a call id that does not exist", async () => {
    const f = await endedSandboxCall()
    const absent = `call_${randomUUID()}`

    expect(
      await getCallObservationsForAccount(
        f.account.accountId,
        absent,
        f.account.userId
      )
    ).toBeNull()
    expect(await save(f.account, absent, observation(0))).toStrictEqual({
      kind: "not_found",
    })
  })
})

describeDatabase("account and author boundaries", () => {
  it("hides another account's call from reads and writes", async () => {
    const f = await endedSandboxCall()
    await saved(f.account, f.agent.callId, observation(0, { note: "private" }))
    const before = await storedRows(f.agent.callId)
    const intruder = await signUpNewAccount()

    expect(
      await getCallObservationsForAccount(
        intruder.accountId,
        f.agent.callId,
        intruder.userId
      )
    ).toBeNull()
    expect(await save(intruder, f.agent.callId, observation(0))).toStrictEqual({
      kind: "not_found",
    })
    expect(await save(intruder, f.agent.callId, observation(1))).toStrictEqual({
      kind: "not_found",
    })
    expect(await storedRows(f.agent.callId)).toStrictEqual(before)
  })

  /**
   * The route passes the session's account and user together, so this pair
   * cannot arrive over HTTP. It proves the write re-derives membership in the
   * database instead of trusting that the two arguments belong together.
   */
  it("refuses a user id that is not a member of the named account", async () => {
    const f = await endedSandboxCall()
    const outsider = await signUpNewAccount()

    expect(
      await putCallObservation(
        f.account.accountId,
        outsider.userId,
        f.agent.callId,
        observation(0)
      )
    ).toStrictEqual({ kind: "not_found" })
    expect(await storedRows(f.agent.callId)).toStrictEqual([])
  })

  it("lets a colleague read my row but not edit it, and keeps theirs separate", async () => {
    const f = await endedSandboxCall()
    const colleague = await colleagueOf(f.account)
    const mine = await saved(
      f.account,
      f.agent.callId,
      observation(0, { note: "author note" })
    )
    const before = await storedRows(f.agent.callId)

    const seenByColleague = await read(colleague, f.agent.callId)
    expect(seenByColleague).toHaveLength(1)
    expect(seenByColleague[0]).toMatchObject({
      id: mine.id,
      note: "author note",
      isMine: false,
    })

    // A colleague aiming at my row's revision is not told it exists as theirs.
    expect(
      await save(colleague, f.agent.callId, observation(mine.revision))
    ).toStrictEqual({ kind: "not_found" })
    expect(await storedRows(f.agent.callId)).toStrictEqual(before)

    const theirs = await saved(
      colleague,
      f.agent.callId,
      observation(0, { note: "colleague note", honestFailureSpeech: "met" })
    )
    expect(theirs.id).not.toBe(mine.id)
    expect(theirs).toMatchObject({ revision: 1, isMine: true })

    const byAuthor = await read(f.account, f.agent.callId)
    // Oldest first, so a list never reshuffles as members save.
    expect(byAuthor.map((row) => row.id)).toStrictEqual([mine.id, theirs.id])
    expect(byAuthor.map((row) => row.isMine)).toStrictEqual([true, false])
    const [authorRow] = (await storedRows(f.agent.callId)).filter(
      (row) => row.id === mine.id
    )
    expect(authorRow).toStrictEqual(before[0])
  })

  it("never exposes an email, user id or account id, even when name equals email", async () => {
    const f = await endedSandboxCall()
    const colleague = await colleagueOf(f.account)
    const [authorUser] = await getDb()
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, f.account.userId))
    // The trap: signup stores the email as the display name, so the name
    // projection must refuse an email-shaped name rather than pass it through.
    expect(authorUser!.name).toBe(f.account.email)

    await saved(f.account, f.agent.callId, observation(0))
    await saved(colleague, f.agent.callId, observation(0))

    for (const viewer of [f.account, colleague]) {
      const rows = await read(viewer, f.agent.callId)
      expect(rows).toHaveLength(2)
      const text = JSON.stringify(rows)
      for (const forbidden of [
        f.account.email,
        colleague.email,
        f.account.userId,
        colleague.userId,
        f.account.accountId,
        f.agent.callId,
      ]) {
        expect(text).not.toContain(forbidden)
      }
      for (const row of rows) {
        expect(Object.keys(row).sort()).toStrictEqual(DTO_KEYS)
        expect(row.authorName).toBe("Member")
      }
    }
  })

  /**
   * `ON DELETE SET NULL` keeps a departed member's review visible and frozen.
   * Nobody's session user is NULL, so no one can edit it again, and the NULL
   * author does not occupy anyone's unique slot.
   */
  it("keeps a deleted author's row as a read-only former member's", async () => {
    const f = await endedSandboxCall()
    const departing = await colleagueOf(f.account)
    const theirs = await saved(
      departing,
      f.agent.callId,
      observation(0, { note: "left behind" })
    )

    await getDb().delete(users).where(eq(users.id, departing.userId))

    const [row] = await storedRows(f.agent.callId)
    expect(row).toMatchObject({ id: theirs.id, authorUserId: null })
    const frozen = await storedRows(f.agent.callId)

    const seen = await read(f.account, f.agent.callId)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      id: theirs.id,
      note: "left behind",
      authorName: "Former member",
      isMine: false,
    })
    expect(JSON.stringify(seen)).not.toContain(departing.email)

    expect(
      await save(f.account, f.agent.callId, observation(theirs.revision))
    ).toStrictEqual({ kind: "not_found" })
    expect(await storedRows(f.agent.callId)).toStrictEqual(frozen)

    // The remaining member can still add their own.
    const mine = await saved(f.account, f.agent.callId, observation(0))
    expect(mine).toMatchObject({ revision: 1, isMine: true })
    expect(await read(f.account, f.agent.callId)).toHaveLength(2)
  })
})

describeDatabase("the author's display name", () => {
  async function rename(userId: string, name: string | null): Promise<void> {
    await getDb().update(users).set({ name }).where(eq(users.id, userId))
  }

  /**
   * A stored name is shown only when it is safe to render as a label: NFC,
   * trimmed, at most 80 code points, no `@` (the signup default is the email),
   * and no control or bidi character. Anything else is "Member". The shown
   * cases are the controls that prove the fallback is not simply always on.
   */
  it.each([
    ["a plain name", "Alex Tester", "Alex Tester"],
    ["surrounding spaces, trimmed", "  Alex Tester  ", "Alex Tester"],
    ["a decomposed name, composed", "Renée Tester", "Renée Tester"],
    ["exactly 80 code points", "a".repeat(80), "a".repeat(80)],
    ["80 astral code points", "\u{1F600}".repeat(80), "\u{1F600}".repeat(80)],
    ["81 code points", "a".repeat(81), "Member"],
    ["an email", "alex@example.invalid", "Member"],
    ["any @", "Alex @ Home", "Member"],
    ["a right-to-left override", "Alex‮Tester", "Member"],
    ["an isolate", "Alex⁦Tester", "Member"],
    ["a BEL", "Alex\u0007", "Member"],
    ["an inner newline", "Alex\nTester", "Member"],
    ["a C1 control", "Alex\u0085Tester", "Member"],
    ["an empty name", "", "Member"],
    ["only whitespace", "   ", "Member"],
    ["no name", null, "Member"],
  ])("shows %s as the label its reader sees", async (_label, name, shown) => {
    const f = await endedSandboxCall()
    const colleague = await colleagueOf(f.account)
    await rename(f.account.userId, name)

    const own = await saved(f.account, f.agent.callId, observation(0))
    expect(own.authorName).toBe(shown)
    for (const viewer of [f.account, colleague]) {
      const [row] = await read(viewer, f.agent.callId)
      expect(row!.authorName).toBe(shown)
    }
    const conflict = await save(f.account, f.agent.callId, observation(0))
    expect(conflict).toMatchObject({
      kind: "conflict",
      current: { authorName: shown },
    })
  })

  it("reflects a rename on the next read without touching the observation", async () => {
    const f = await endedSandboxCall()
    await rename(f.account.userId, "Alex Tester")
    await saved(f.account, f.agent.callId, observation(0))
    const before = await storedRows(f.agent.callId)

    await rename(f.account.userId, "Sam Tester")

    const [row] = await read(f.account, f.agent.callId)
    expect(row!.authorName).toBe("Sam Tester")
    expect(await storedRows(f.agent.callId)).toStrictEqual(before)
  })

  it("shows Former member even when the departed author had a safe name", async () => {
    const f = await endedSandboxCall()
    const departing = await colleagueOf(f.account)
    await rename(departing.userId, "Alex Tester")
    await saved(departing, f.agent.callId, observation(0))
    expect((await read(f.account, f.agent.callId))[0]!.authorName).toBe(
      "Alex Tester"
    )

    await getDb().delete(users).where(eq(users.id, departing.userId))

    expect((await read(f.account, f.agent.callId))[0]!.authorName).toBe(
      "Former member"
    )
  })
})

describeDatabase("observations never touch runtime evidence", () => {
  it("leaves the call, its events and its evidence ledger byte-identical", async () => {
    const f = await endedSandboxCall()
    const colleague = await colleagueOf(f.account)
    const before = await runtimeRecord(f.agent.callId)
    expect(before.events.length).toBeGreaterThan(0)
    expect(before.ledger).toHaveLength(1)

    await saved(f.account, f.agent.callId, observation(0, { note: "a" }))
    await saved(
      f.account,
      f.agent.callId,
      observation(1, {
        heardExpectedAnswer: "met",
        correctToolOutcome: "met",
        honestFailureSpeech: "met",
        acceptableInterruptionWaiting: "met",
      })
    )
    await save(f.account, f.agent.callId, observation(1))
    await saved(colleague, f.agent.callId, observation(0))

    expect(await runtimeRecord(f.agent.callId)).toStrictEqual(before)
  })

  /**
   * "Met" everywhere must not upgrade Partial evidence. The evidence here is
   * partial because a sealed range has a gap; after every answer is Met the
   * ledger still says so.
   */
  it("does not turn partial evidence complete when every answer is met", async () => {
    const f = await sandboxFixture()
    await f.evidence.ingest(f.agent, [event(2)])
    expect(await f.evidence.complete(f.agent, completion)).toMatchObject({
      kind: "ok",
      ack: { evidenceState: "partial" },
    })
    const before = await runtimeRecord(f.agent.callId)

    await saved(
      f.account,
      f.agent.callId,
      observation(0, {
        heardExpectedAnswer: "met",
        correctToolOutcome: "met",
        honestFailureSpeech: "met",
        acceptableInterruptionWaiting: "met",
      })
    )

    expect(await runtimeRecord(f.agent.callId)).toStrictEqual(before)
  })

  /**
   * The inverse direction from the review flow: a completion arriving after a
   * human wrote their observation changes evidence and leaves the observation
   * exactly as the human left it.
   */
  it("keeps the observation untouched when late evidence reconciles", async () => {
    const f = await sandboxFixture()
    await f.evidence.ingest(f.agent, [event(2)])
    await f.evidence.complete(f.agent, completion)
    await saved(
      f.account,
      f.agent.callId,
      observation(0, { correctToolOutcome: "not_checked", note: "unsure" })
    )
    const before = await storedRows(f.agent.callId)

    expect(
      await f.evidence.ingest(f.agent, [event(1, "agent_ready")])
    ).toMatchObject({ kind: "ok", ack: { evidenceState: "complete" } })

    expect(await storedRows(f.agent.callId)).toStrictEqual(before)
  })
})
