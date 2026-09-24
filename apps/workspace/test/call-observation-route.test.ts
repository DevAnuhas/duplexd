import { randomUUID } from "node:crypto"

import { afterAll, afterEach, describe, expect, it, vi } from "vitest"

import type { SignedUpUser } from "./helpers/auth.ts"

const requestHeaders = { current: new Headers() }

vi.mock("next/headers", () => ({
  headers: async () => requestHeaders.current,
}))

const { GET: getCsrf } = await import("@/app/api/workspace/sandbox/csrf/route")
const { GET: getObservations, PUT: putObservation } =
  await import("@/app/api/workspace/calls/[id]/observations/route")
const { OBSERVATION_BODY_LIMIT } = await import("@/data/observations")
const { eq } = await import("drizzle-orm")
const { closeDb, getDb } = await import("@/db/client")
const { callObservations, calls, users } = await import("@/db/schema")
const { signUpNewAccount } = await import("./helpers/auth.ts")
const { isDatabaseConfigured } = await import("./helpers/environment.ts")
const { sandboxFixture } = await import("./helpers/sandbox.ts")

/**
 * #65: the observation route over HTTP.
 *
 * `call-observations.test.ts` owns the write rules. This file owns what only
 * the route can get wrong: the mutation guard in front of it, the body reader,
 * the status and code each outcome maps to, `no-store` on every answer, the
 * account and user coming from the session and nowhere else, and a note that
 * never leaves through a log line or an error body.
 */

const ORIGIN = "http://localhost:3000"
const URL_BASE = `${ORIGIN}/api/workspace/calls`
const AT = "2026-09-22T00:00:00.000Z"

const ANSWERS = {
  heardExpectedAnswer: "met",
  correctToolOutcome: "needs_work",
  honestFailureSpeech: "not_checked",
  acceptableInterruptionWaiting: "met",
} as const

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

const describeDatabase = describe.skipIf(!isDatabaseConfigured())

afterAll(closeDb)
afterEach(() => {
  vi.restoreAllMocks()
})

const routeContext = (id: string) => ({ params: Promise.resolve({ id }) })

function body(expectedRevision: number, overrides: object = {}) {
  return { expectedRevision, ...ANSWERS, note: "", ...overrides }
}

async function csrfFor(account: SignedUpUser): Promise<string> {
  requestHeaders.current = new Headers({ cookie: account.cookie })
  const response = await getCsrf()
  expect(response.status).toBe(200)
  return ((await response.json()) as { token: string }).token
}

type Headed = {
  origin?: string | null
  csrf?: string | null
  fetchSite?: string | null
  contentType?: string | null
}

/**
 * A PUT as the browser sends it. Every header defaults to the valid value, so
 * a test that drops one changes exactly one thing.
 */
async function put(
  account: SignedUpUser,
  callId: string,
  payload: unknown,
  headed: Headed = {}
): Promise<Response> {
  const csrf = headed.csrf === undefined ? await csrfFor(account) : headed.csrf
  requestHeaders.current = new Headers({ cookie: account.cookie })
  const headers = new Headers()
  const values = {
    origin: headed.origin === undefined ? ORIGIN : headed.origin,
    "x-duplexd-csrf": csrf,
    "sec-fetch-site":
      headed.fetchSite === undefined ? "same-origin" : headed.fetchSite,
    "content-type":
      headed.contentType === undefined
        ? "application/json"
        : headed.contentType,
  }
  for (const [name, value] of Object.entries(values)) {
    if (value !== null) headers.set(name, value)
  }
  return putObservation(
    new Request(`${URL_BASE}/${callId}/observations`, {
      method: "PUT",
      headers,
      body: typeof payload === "string" ? payload : JSON.stringify(payload),
    }),
    routeContext(callId)
  )
}

async function get(account: SignedUpUser | null, callId: string) {
  requestHeaders.current = new Headers(
    account === null ? {} : { cookie: account.cookie }
  )
  return getObservations(
    new Request(`${URL_BASE}/${callId}/observations`),
    routeContext(callId)
  )
}

function expectNoStore(response: Response): void {
  expect(response.headers.get("cache-control")).toBe("no-store")
}

async function problem(response: Response, status: number, code: string) {
  expect(response.status).toBe(status)
  expectNoStore(response)
  const parsed = (await response.json()) as Record<string, unknown>
  expect(parsed.code).toBe(code)
  return parsed
}

async function rowsFor(callId: string) {
  return getDb()
    .select()
    .from(callObservations)
    .where(eq(callObservations.callId, callId))
}

function event(seq: number, type = "interruption") {
  return { seq, at: AT, type, payload: {} }
}

async function endedSandboxCall() {
  const f = await sandboxFixture()
  await f.evidence.ingest(f.agent, [event(1, "agent_ready"), event(2)])
  await f.evidence.complete(f.agent, {
    endedReason: "client_disconnected",
    durationSecs: 2.5,
    finalSeq: 2,
    producerLoss: false,
    truncated: false,
  })
  return f
}

async function colleagueOf(owner: SignedUpUser): Promise<SignedUpUser> {
  const colleague = await signUpNewAccount()
  await getDb()
    .update(users)
    .set({ accountId: owner.accountId })
    .where(eq(users.id, colleague.userId))
  return { ...colleague, accountId: owner.accountId }
}

describeDatabase("the session requirement", () => {
  it("answers both methods with 401 and no-store when signed out", async () => {
    const f = await endedSandboxCall()
    requestHeaders.current = new Headers()

    await problem(
      await get(null, f.agent.callId),
      401,
      "workspace_session_required"
    )
    await problem(
      await putObservation(
        new Request(`${URL_BASE}/${f.agent.callId}/observations`, {
          method: "PUT",
          headers: {
            origin: ORIGIN,
            "content-type": "application/json",
            "sec-fetch-site": "same-origin",
          },
          body: JSON.stringify(body(0)),
        }),
        routeContext(f.agent.callId)
      ),
      401,
      "workspace_session_required"
    )
    expect(await rowsFor(f.agent.callId)).toStrictEqual([])
  })
})

describeDatabase("the mutation guard in front of PUT", () => {
  /**
   * Each case drops or corrupts one header of an otherwise valid request and
   * names the rule that must fire. The last case is the control: the same
   * request with nothing removed is accepted, so every rejection above it is
   * about the header it changed.
   */
  it("rejects each broken header with its own code, and accepts the intact request", async () => {
    const f = await endedSandboxCall()
    const colleague = await colleagueOf(f.account)
    const foreignToken = await csrfFor(colleague)
    const cases: Array<[string, Headed, number, string]> = [
      ["no Origin", { origin: null }, 403, "invalid_origin"],
      [
        "a foreign Origin",
        { origin: "https://evil.example.invalid" },
        403,
        "invalid_origin",
      ],
      [
        "an Origin with a path",
        { origin: `${ORIGIN}/` },
        403,
        "invalid_origin",
      ],
      ["the null Origin", { origin: "null" }, 403, "invalid_origin"],
      [
        "cross-site fetch metadata",
        { fetchSite: "cross-site" },
        403,
        "invalid_origin",
      ],
      [
        "same-site fetch metadata",
        { fetchSite: "same-site" },
        403,
        "invalid_origin",
      ],
      [
        "a form content type",
        { contentType: "application/x-www-form-urlencoded" },
        415,
        "invalid_content_type",
      ],
      [
        "a text/plain content type",
        { contentType: "text/plain" },
        415,
        "invalid_content_type",
      ],
      ["no CSRF token", { csrf: null }, 403, "invalid_csrf_token"],
      ["an empty CSRF token", { csrf: "" }, 403, "invalid_csrf_token"],
      [
        "another session's valid CSRF token",
        { csrf: foreignToken },
        403,
        "invalid_csrf_token",
      ],
    ]

    for (const [label, headed, status, code] of cases) {
      const response = await put(f.account, f.agent.callId, body(0), headed)
      expect(response.status, label).toBe(status)
      expectNoStore(response)
      expect(((await response.json()) as { code: string }).code, label).toBe(
        code
      )
      expect(await rowsFor(f.agent.callId), label).toStrictEqual([])
    }

    const control = await put(f.account, f.agent.callId, body(0))
    expect(control.status).toBe(200)
    expect(await rowsFor(f.agent.callId)).toHaveLength(1)
  })

  it("accepts a request without fetch metadata, as older browsers send it", async () => {
    const f = await endedSandboxCall()
    const response = await put(f.account, f.agent.callId, body(0), {
      fetchSite: null,
    })
    expect(response.status).toBe(200)
  })
})

describeDatabase("the request body", () => {
  it("rejects malformed JSON, a non-object and an invalid observation without writing", async () => {
    const f = await endedSandboxCall()

    await problem(
      await put(f.account, f.agent.callId, "{not json"),
      400,
      "invalid_request"
    )
    await problem(
      await put(f.account, f.agent.callId, [body(0)]),
      400,
      "invalid_request"
    )
    for (const invalid of [
      body(-1),
      body(0, { heardExpectedAnswer: "passed" }),
      body(0, { note: "a".repeat(2_001) }),
      body(0, { note: "bidi ‮ trick" }),
      body(0, { checklistVersion: 2 }),
      { ...ANSWERS, note: "" },
    ]) {
      await problem(
        await put(f.account, f.agent.callId, invalid),
        400,
        "invalid_observation"
      )
    }
    expect(await rowsFor(f.agent.callId)).toStrictEqual([])
  })

  /**
   * Sized from the exported limit, so raising it cannot quietly turn this into
   * a validation test. The body is one byte over; a 400 here would mean the
   * reader let an oversized body through to the parser.
   */
  it("rejects a body one byte over the limit with 413", async () => {
    const f = await endedSandboxCall()
    const envelope = JSON.stringify(body(0)).length
    const payload = JSON.stringify(
      body(0, { note: "a".repeat(OBSERVATION_BODY_LIMIT - envelope + 1) })
    )
    expect(Buffer.byteLength(payload)).toBe(OBSERVATION_BODY_LIMIT + 1)

    await problem(
      await put(f.account, f.agent.callId, payload),
      413,
      "request_too_large"
    )
    expect(await rowsFor(f.agent.callId)).toStrictEqual([])
  })

  /**
   * The largest valid note, in both encodings a client may send. A browser's
   * `JSON.stringify` leaves astral characters raw (4 bytes each, 8,000 total);
   * another client may escape each as a surrogate pair (12 bytes each, 24,000
   * total). The parser accepts both, so the byte limit must admit both.
   */
  it.each([
    ["raw, as a browser sends it", (json: string) => json],
    [
      "as escaped surrogate pairs",
      (json: string) => json.replaceAll("\u{1F600}", "\\ud83d\\ude00"),
    ],
  ])("admits the largest valid note %s", async (_label, encode) => {
    const f = await endedSandboxCall()
    const note = "\u{1F600}".repeat(2_000)
    const payload = encode(JSON.stringify(body(0, { note })))
    expect(Buffer.byteLength(payload)).toBeLessThanOrEqual(
      OBSERVATION_BODY_LIMIT
    )

    const response = await put(f.account, f.agent.callId, payload)

    expect(response.status).toBe(200)
    const [row] = await rowsFor(f.agent.callId)
    expect(row!.note).toBe(note)
  })

  it("confirms the escaped encoding is really the larger one", () => {
    const note = "\u{1F600}".repeat(2_000)
    const raw = JSON.stringify(body(0, { note }))
    const escaped = raw.replaceAll("\u{1F600}", "\\ud83d\\ude00")
    expect(JSON.parse(escaped)).toStrictEqual(JSON.parse(raw))
    expect(Buffer.byteLength(escaped) - Buffer.byteLength(raw)).toBe(16_000)
  })
})

describeDatabase("the outcomes", () => {
  it("saves with 200 and returns exactly the safe observation", async () => {
    const f = await endedSandboxCall()
    const response = await put(
      f.account,
      f.agent.callId,
      body(0, { note: "Heard it." })
    )

    expect(response.status).toBe(200)
    expectNoStore(response)
    const parsed = (await response.json()) as {
      observation: Record<string, unknown>
    }
    expect(Object.keys(parsed)).toStrictEqual(["observation"])
    expect(Object.keys(parsed.observation).sort()).toStrictEqual(DTO_KEYS)
    expect(parsed.observation).toMatchObject({
      revision: 1,
      checklistVersion: 1,
      ...ANSWERS,
      note: "Heard it.",
      isMine: true,
      authorName: "Member",
    })
    expect(new Date(parsed.observation.createdAt as string).toISOString()).toBe(
      parsed.observation.createdAt
    )

    const read = await get(f.account, f.agent.callId)
    expect(read.status).toBe(200)
    expectNoStore(read)
    expect(await read.json()).toStrictEqual({
      observations: [parsed.observation],
    })
  })

  it("answers a stale write with 409 and the current row, leaving it unchanged", async () => {
    const f = await endedSandboxCall()
    expect((await put(f.account, f.agent.callId, body(0))).status).toBe(200)
    const second = await put(f.account, f.agent.callId, body(1, { note: "2" }))
    const { observation: current } = (await second.json()) as {
      observation: Record<string, unknown>
    }
    const before = await rowsFor(f.agent.callId)

    for (const stale of [body(0, { note: "x" }), body(1, { note: "y" })]) {
      const parsed = await problem(
        await put(f.account, f.agent.callId, stale),
        409,
        "observation_conflict"
      )
      expect(parsed.current).toStrictEqual(current)
    }
    expect(await rowsFor(f.agent.callId)).toStrictEqual(before)
  })

  /**
   * Five different reasons a PUT cannot land, one response. A caller must not
   * be able to tell a foreign call from a missing one, a running call from an
   * Integration call, or a colleague's row from no row.
   */
  it("gives foreign, absent, Integration, running and colleague-owned targets one identical 404", async () => {
    const f = await endedSandboxCall()
    const colleague = await colleagueOf(f.account)
    const intruder = await signUpNewAccount()
    expect((await put(f.account, f.agent.callId, body(0))).status).toBe(200)

    const running = await sandboxFixture()
    const integrationId = `call_${randomUUID()}`
    await getDb().insert(calls).values({
      id: integrationId,
      accountId: f.account.accountId,
      assistantSnapshot: {},
      source: "integration",
      state: "ended",
      endedReason: "client_disconnected",
    })

    const responses: Array<[string, Response]> = [
      ["foreign", await put(intruder, f.agent.callId, body(0))],
      ["foreign update", await put(intruder, f.agent.callId, body(1))],
      ["absent", await put(f.account, `call_${randomUUID()}`, body(0))],
      ["integration", await put(f.account, integrationId, body(0))],
      ["running", await put(running.account, running.agent.callId, body(0))],
      ["colleague's row", await put(colleague, f.agent.callId, body(1))],
    ]

    const texts = new Set<string>()
    for (const [label, response] of responses) {
      expect(response.status, label).toBe(404)
      expectNoStore(response)
      texts.add(await response.text())
    }
    expect(texts.size).toBe(1)
    expect(JSON.parse([...texts][0]!)).toMatchObject({ code: "call_not_found" })

    expect(await rowsFor(integrationId)).toStrictEqual([])
    expect(await rowsFor(running.agent.callId)).toStrictEqual([])
    expect(await rowsFor(f.agent.callId)).toHaveLength(1)
  })

  it("makes a foreign call's GET indistinguishable from an absent one", async () => {
    const f = await endedSandboxCall()
    expect((await put(f.account, f.agent.callId, body(0))).status).toBe(200)
    const intruder = await signUpNewAccount()

    const foreign = await get(intruder, f.agent.callId)
    const absent = await get(intruder, `call_${randomUUID()}`)
    expect(foreign.status).toBe(404)
    expectNoStore(foreign)
    expect(await foreign.text()).toBe(await absent.text())
  })
})

describeDatabase("the session is the only authority", () => {
  it("shows a colleague the author's row as theirs to read, not to edit", async () => {
    const f = await endedSandboxCall()
    const colleague = await colleagueOf(f.account)
    expect(
      (await put(f.account, f.agent.callId, body(0, { note: "by author" })))
        .status
    ).toBe(200)

    const seen = (await (await get(colleague, f.agent.callId)).json()) as {
      observations: Array<Record<string, unknown>>
    }
    expect(seen.observations).toHaveLength(1)
    expect(seen.observations[0]).toMatchObject({
      note: "by author",
      isMine: false,
      authorName: "Member",
    })
  })

  /**
   * The body cannot name an account, author or call: the parser rejects
   * unknown keys outright. The URL names the call and the session names the
   * rest, so a request aimed at another account's call is a 404 no matter
   * what it claims.
   */
  it("rejects a body that names an account or author with 400", async () => {
    const f = await endedSandboxCall()
    const intruder = await signUpNewAccount()

    await problem(
      await put(
        intruder,
        f.agent.callId,
        body(0, { accountId: f.account.accountId })
      ),
      400,
      "invalid_observation"
    )
    await problem(
      await put(
        intruder,
        f.agent.callId,
        body(0, { authorUserId: f.account.userId })
      ),
      400,
      "invalid_observation"
    )
    expect(await rowsFor(f.agent.callId)).toStrictEqual([])
  })
})

describeDatabase("what leaves the server", () => {
  /**
   * A distinctive note, then every path it can travel: saved, read back by a
   * colleague, returned in a conflict, and rejected as invalid. It must reach
   * the database and the author's own responses (proving the canary is live)
   * and never reach a log line, and neither member's email may appear in any
   * body. The console spy is proven live by a line this test writes itself.
   */
  it("never logs a note or returns an email on any path", async () => {
    const f = await endedSandboxCall()
    const colleague = await colleagueOf(f.account)
    const canary = `note-canary-${randomUUID()}`
    const logged: string[] = []
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((arg) => String(arg)).join(" "))
      })
    }
    console.info("spy-control")
    expect(logged).toContain("spy-control")

    const bodies: string[] = []
    const record = async (response: Response) => {
      const text = await response.text()
      bodies.push(text)
      return text
    }

    expect(
      await record(
        await put(f.account, f.agent.callId, body(0, { note: canary }))
      )
    ).toContain(canary)
    await record(await get(f.account, f.agent.callId))
    await record(await get(colleague, f.agent.callId))
    expect(
      await record(
        await put(f.account, f.agent.callId, body(0, { note: "stale" }))
      )
    ).toContain(canary)
    expect(
      await record(
        await put(f.account, f.agent.callId, body(1, { note: `${canary}‮` }))
      )
    ).not.toContain(canary)
    await record(await put(colleague, f.agent.callId, body(1)))

    const [row] = await rowsFor(f.agent.callId)
    expect(row!.note).toBe(canary)

    expect(logged.filter((line) => line.includes(canary))).toStrictEqual([])
    const everything = bodies.join("\n")
    for (const forbidden of [
      f.account.email,
      colleague.email,
      f.account.userId,
      colleague.userId,
      f.account.accountId,
    ]) {
      expect(everything).not.toContain(forbidden)
    }
  })
})
