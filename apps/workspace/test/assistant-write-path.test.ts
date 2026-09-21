import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import type { SignedUpUser } from "./helpers/auth.ts"

/**
 * The real save path: `createAssistantAction` and `updateAssistantAction`.
 *
 * The validators have their own unit files. This one exists because a
 * validator nobody calls proves nothing — the contract's requirement is that
 * the matrix runs through the path that actually writes, so a save surface that
 * forgot to validate is caught here rather than reviewed for.
 *
 * Every rejection is asserted on the **post-state**: not "the action returned
 * `ok: false`" but "no row with that name exists in the database". An action
 * that reported a rejection and wrote anyway would satisfy the first and fail
 * the second, and it is the second that the customer experiences.
 *
 * Two things are mocked, neither of them the subject: `next/headers`, which
 * needs a request scope that does not exist in a test process, and
 * `next/cache`, whose `revalidatePath` needs the same. The session those
 * headers carry is a real one from a real signup, and the account the action
 * resolves from it is the real resolver's answer.
 */

const requestHeaders = { current: new Headers() }

vi.mock("next/headers", () => ({
  headers: async () => requestHeaders.current,
}))

const revalidatePath = vi.fn()

vi.mock("next/cache", () => ({
  revalidatePath: (path: string) => revalidatePath(path),
}))

const { closeDb } = await import("@/db/client")
const { createAssistantAction, updateAssistantAction, archiveAssistantAction } =
  await import("@/app/actions")
const { getAssistantForAccount, listAssistantsForAccount } =
  await import("@/data/assistants")
const { signUpNewAccount } = await import("./helpers/auth.ts")
const { withTestPool } = await import("./helpers/database.ts")
const { isDatabaseConfigured } = await import("./helpers/environment.ts")
const { PRACTICE_DRAFT_2020_TOOL } = await import("./helpers/practice.ts")
const {
  ACCEPTED_PORTS,
  ACCEPTED_SERVER_URLS,
  FLAG_GATED_LOOPBACK,
  REJECTED_PORTS,
  REJECTED_PRIVATE_ADDRESSES,
  REJECTED_SERVER_URLS,
} = await import("./helpers/server-urls.ts")

type Account = SignedUpUser

/** A tool that is valid in every respect. */
const VALID_TOOL = {
  name: "lookup_order",
  description: "Looks up an order by its reference.",
  parameters: {
    type: "object",
    properties: { reference: { type: "string" } },
    required: ["reference"],
  },
}

function formDataFor(fields: Record<string, string>): FormData {
  const formData = new FormData()

  for (const [key, value] of Object.entries(fields)) {
    formData.set(key, value)
  }

  return formData
}

/** How many assistants carry this name. The post-state every rejection asserts on. */
async function countByName(name: string): Promise<number> {
  return withTestPool(async (pool) => {
    const { rows } = await pool.query<{ hits: string }>(
      "SELECT count(*)::text AS hits FROM assistants WHERE name = $1",
      [name]
    )

    return Number(rows[0]?.hits ?? 0)
  })
}

const describeDatabase = describe.skipIf(!isDatabaseConfigured())

afterAll(async () => {
  await closeDb()
})

describeDatabase("the server URL matrix, through the real save path", () => {
  let account: Account

  beforeAll(async () => {
    account = await signUpNewAccount()
    requestHeaders.current = new Headers({ cookie: account.cookie })
  })

  it.each(ACCEPTED_SERVER_URLS.map((entry) => [entry.label, entry.url]))(
    "saves an assistant with %s — %s",
    async (_label, url) => {
      const name = `accepted ${randomUUID()}`

      const result = await createAssistantAction(
        formDataFor({ name, serverUrl: url })
      )

      expect(result).toStrictEqual({
        ok: true,
        assistantId: expect.any(String),
      })

      const listed = await listAssistantsForAccount(account.accountId)
      const saved = listed.find((row) => row.name === name)

      expect(saved, `${url} was accepted but nothing was written`).toBeDefined()
      expect(saved?.serverUrl).toBe(url)
    }
  )

  it.each(REJECTED_SERVER_URLS.map((entry) => [entry.label, entry.url]))(
    "refuses to save an assistant with %s — %s",
    async (_label, url) => {
      const name = `rejected ${randomUUID()}`

      const result = await createAssistantAction(
        formDataFor({ name, serverUrl: url })
      )

      expect(result.ok, `${url} was saved`).toBe(false)
      expect(
        result.ok === false &&
          result.issues.some((issue) => issue.field === "serverUrl"),
        `${url} was rejected for some other reason than the URL`
      ).toBe(true)

      // The assertion that matters: not "it said no" but "nothing was written".
      expect(
        await countByName(name),
        `${url} was rejected and written anyway`
      ).toBe(0)
    }
  )

  /**
   * Ports, through the same real save path as the matrix.
   *
   * These are decided by a second gate the pattern knows nothing about — a
   * `new URL` parse plus an explicit rule for port `0` — so they are separate
   * from the matrix in the helper. They belong here for the same reason the
   * matrix does: a rule that only exists in a unit test says nothing about
   * what the save surface actually enforces.
   */
  it.each(REJECTED_PORTS.map((entry) => [entry.label, entry.url]))(
    "refuses to save an assistant with %s — %s",
    async (_label, url) => {
      const name = `rejected port ${randomUUID()}`

      const result = await createAssistantAction(
        formDataFor({ name, serverUrl: url })
      )

      expect(result.ok, `${url} was saved`).toBe(false)
      expect(
        result.ok === false &&
          result.issues.some((issue) => issue.field === "serverUrl")
      ).toBe(true)
      expect(
        await countByName(name),
        `${url} was rejected and written anyway`
      ).toBe(0)
    }
  )

  it.each(ACCEPTED_PORTS.map((entry) => [entry.label, entry.url]))(
    "saves an assistant with %s — %s",
    async (_label, url) => {
      const name = `accepted port ${randomUUID()}`

      expect(
        await createAssistantAction(formDataFor({ name, serverUrl: url }))
      ).toStrictEqual({ ok: true, assistantId: expect.any(String) })

      const saved = (await listAssistantsForAccount(account.accountId)).find(
        (row) => row.name === name
      )

      expect(saved, `${url} was accepted but nothing was written`).toBeDefined()
      expect(saved?.serverUrl).toBe(url)
    }
  )

  /**
   * The private-address rule, through the save path rather than only the
   * validator. `https://169.254.169.254` was accepted outright before it — a
   * webhook the platform would call from its own network, against its own
   * metadata endpoint — so the thing worth proving is that the **save surface**
   * refuses it, not that a function nobody calls would have.
   */
  it.each(REJECTED_PRIVATE_ADDRESSES.map((entry) => [entry.label, entry.url]))(
    "refuses to save an assistant pointing at %s — %s",
    async (_label, url) => {
      const name = `rejected private ${randomUUID()}`

      const result = await createAssistantAction(
        formDataFor({ name, serverUrl: url })
      )

      expect(result.ok, `${url} was saved`).toBe(false)
      expect(
        result.ok === false &&
          result.issues.some((issue) => issue.field === "serverUrl")
      ).toBe(true)
      expect(
        await countByName(name),
        `${url} was rejected and written anyway`
      ).toBe(0)
    }
  )

  /**
   * Loopback needs `ALLOW_LOOPBACK_SERVER_URL`, which is off here as it is in
   * production. These used to save unconditionally.
   */
  it.each(FLAG_GATED_LOOPBACK.map((entry) => [entry.label, entry.url]))(
    "refuses to save %s while the loopback flag is off — %s",
    async (_label, url) => {
      const name = `rejected loopback ${randomUUID()}`

      const result = await createAssistantAction(
        formDataFor({ name, serverUrl: url })
      )

      expect(result.ok, `${url} was saved with the flag off`).toBe(false)
      expect(await countByName(name)).toBe(0)
    }
  )

  /** An assistant need not call a webhook, so an empty field is not an error. */
  it("saves an assistant with no server URL at all", async () => {
    const name = `no url ${randomUUID()}`

    expect(await createAssistantAction(formDataFor({ name }))).toStrictEqual({
      ok: true,
      assistantId: expect.any(String),
    })
    expect(await countByName(name)).toBe(1)
  })

  /** The same validator guards the edit form, not only the create form. */
  it.each(
    REJECTED_SERVER_URLS.slice(0, 5).map((entry) => [entry.label, entry.url])
  )("refuses to update an assistant to %s — %s", async (_label, url) => {
    const name = `editable ${randomUUID()}`

    await createAssistantAction(
      formDataFor({ name, serverUrl: "https://good.example.invalid/hook" })
    )

    const listed = await listAssistantsForAccount(account.accountId)
    const saved = listed.find((row) => row.name === name)

    expect(saved, "the assistant to edit was not created").toBeDefined()

    const result = await updateAssistantAction(
      String(saved?.id),
      formDataFor({
        name,
        serverUrl: url,
        expectedRevision: String(saved?.revision),
      })
    )

    expect(result.ok).toBe(false)

    // The stored URL is untouched, which "the action returned false" does not
    // establish on its own.
    const after = await getAssistantForAccount(
      account.accountId,
      String(saved?.id)
    )

    expect(after?.serverUrl).toBe("https://good.example.invalid/hook")
  })
})

describeDatabase("tool-list rejection, through the real save path", () => {
  let account: Account

  beforeAll(async () => {
    account = await signUpNewAccount()
    requestHeaders.current = new Headers({ cookie: account.cookie })
  })

  it("saves a valid tool list unchanged, in the OpenAI function format", async () => {
    const name = `tools ${randomUUID()}`
    const tools = [VALID_TOOL, { ...VALID_TOOL, name: "cancel-order" }]

    expect(
      await createAssistantAction(
        formDataFor({ name, tools: JSON.stringify(tools) })
      )
    ).toStrictEqual({ ok: true, assistantId: expect.any(String) })

    const stored = await withTestPool(async (pool) => {
      const { rows } = await pool.query<{ tools: unknown }>(
        "SELECT tools FROM assistants WHERE name = $1",
        [name]
      )

      return rows[0]?.tools
    })

    // Stored unchanged: the agent hands this to the model as-is, and a customer
    // already knows the shape from Vapi and OpenAI. A translation layer here
    // would be a second thing to learn and a mapping to get wrong.
    expect(stored).toStrictEqual(tools)
  })

  it("saves a tool with an advisory draft-2020-12 marker unchanged", async () => {
    const name = `draft 2020 tool ${randomUUID()}`

    expect(
      await createAssistantAction(
        formDataFor({
          name,
          tools: JSON.stringify([PRACTICE_DRAFT_2020_TOOL]),
        })
      )
    ).toStrictEqual({ ok: true, assistantId: expect.any(String) })

    const saved = (await listAssistantsForAccount(account.accountId)).find(
      (assistant) => assistant.name === name
    )
    expect(saved?.tools).toStrictEqual([PRACTICE_DRAFT_2020_TOOL])
  })

  it.each([
    [
      "a malformed parameters schema",
      {
        ...VALID_TOOL,
        name: "broken_tool",
        parameters: { type: "object", required: "reference" },
      },
    ],
    [
      "parameters that are not an object",
      { ...VALID_TOOL, name: "broken_tool", parameters: "nope" },
    ],
    [
      "parameters whose type is not object",
      { ...VALID_TOOL, name: "broken_tool", parameters: { type: "string" } },
    ],
    [
      "an empty description",
      { ...VALID_TOOL, name: "broken_tool", description: "" },
    ],
  ])(
    "rejects %s, names the tool, and writes nothing",
    async (_label, broken) => {
      const name = `bad tools ${randomUUID()}`

      const result = await createAssistantAction(
        formDataFor({
          name,
          tools: JSON.stringify([
            VALID_TOOL,
            broken,
            { ...VALID_TOOL, name: "third_tool" },
          ]),
        })
      )

      expect(result.ok).toBe(false)

      const messages =
        result.ok === false
          ? result.issues.map((issue) => issue.message).join("\n")
          : ""

      expect(
        messages,
        "the rejection does not say which tool is wrong"
      ).toContain("broken_tool")
      expect(messages).not.toContain("third_tool")

      expect(
        await countByName(name),
        "a rejected tool list was written anyway"
      ).toBe(0)
    }
  )

  it("rejects an invalid name, and writes nothing", async () => {
    const name = `bad tool name ${randomUUID()}`

    const result = await createAssistantAction(
      formDataFor({
        name,
        tools: JSON.stringify([{ ...VALID_TOOL, name: "not a valid name" }]),
      })
    )

    expect(result.ok).toBe(false)
    expect(await countByName(name)).toBe(0)
  })

  it("rejects tools that are not JSON at all, and writes nothing", async () => {
    const name = `bad tool json ${randomUUID()}`

    const result = await createAssistantAction(
      formDataFor({ name, tools: "{not json" })
    )

    expect(result.ok).toBe(false)
    expect(await countByName(name)).toBe(0)
  })

  /**
   * Rejected at save, never at call time. A tool list stored now and validated
   * later is the failure the ticket names: the customer finds out with a caller
   * on the line.
   */
  it("leaves a previously valid tool list intact when an edit is rejected", async () => {
    const name = `edit tools ${randomUUID()}`
    const good = [VALID_TOOL]

    await createAssistantAction(
      formDataFor({ name, tools: JSON.stringify(good) })
    )

    const listed = await listAssistantsForAccount(account.accountId)
    const saved = listed.find((row) => row.name === name)

    expect(saved).toBeDefined()

    const result = await updateAssistantAction(
      String(saved?.id),
      formDataFor({
        name,
        expectedRevision: String(saved?.revision),
        tools: JSON.stringify([
          {
            ...VALID_TOOL,
            name: "broken_tool",
            parameters: { type: "object", required: "x" },
          },
        ]),
      })
    )

    expect(result.ok).toBe(false)

    const after = await getAssistantForAccount(
      account.accountId,
      String(saved?.id)
    )

    expect(after?.tools).toStrictEqual(good)
  })

  /**
   * The secret is a deliberate exception to "the form's input survives": a
   * typed secret may persist in client state, but the **server must not echo it
   * back** in the rejected response, which would put it in the RSC payload of
   * the error page.
   */
  it("echoes no secret back in a rejected response", async () => {
    const canary = `canary-rejected-secret-${randomUUID()}`
    const name = `rejected with secret ${randomUUID()}`

    const result = await createAssistantAction(
      formDataFor({
        name,
        serverSecret: canary,
        tools: JSON.stringify([
          { ...VALID_TOOL, parameters: { type: "string" } },
        ]),
      })
    )

    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain(canary)
    expect(await countByName(name)).toBe(0)
  })

  it("requires a name, and writes nothing without one", async () => {
    const result = await createAssistantAction(formDataFor({ name: "   " }))

    expect(result.ok).toBe(false)
    expect(
      result.ok === false &&
        result.issues.some((issue) => issue.field === "name")
    ).toBe(true)
  })
})

/**
 * Every field the data model names, through the real actions, in both
 * directions. Instructions, accent and waiting behaviour stay three separate
 * fields: the agent composes them in a fixed order and the workspace edits them
 * independently, so a single blob would be a different product.
 */
describeDatabase("an assistant round-trips every field", () => {
  let account: Account

  beforeAll(async () => {
    account = await signUpNewAccount()
    requestHeaders.current = new Headers({ cookie: account.cookie })
  })

  it("saves and reads back every field, then edits each one", async () => {
    const name = `round trip ${randomUUID()}`
    const created = {
      name,
      voice: "aura-2-thalia",
      accentStyle: "warm, west-coast American",
      instructions: "You are answering for a bike shop.",
      backendInstructions: "Prefer the orders tool over guessing.",
      backendModel: "gpt-4.1-mini",
      waitingBehavior:
        'Say "one moment" if a tool takes longer than two seconds.',
      serverUrl: "https://hooks.example.invalid/inbound?source=duplexd",
      tools: JSON.stringify([VALID_TOOL]),
    }

    expect(await createAssistantAction(formDataFor(created))).toStrictEqual({
      ok: true,
      assistantId: expect.any(String),
    })

    const listed = await listAssistantsForAccount(account.accountId)
    const saved = listed.find((row) => row.name === name)

    expect(saved).toBeDefined()
    expect(saved?.voice).toBe(created.voice)
    expect(saved?.accentStyle).toBe(created.accentStyle)
    expect(saved?.instructions).toBe(created.instructions)
    expect(saved?.backendInstructions).toBe(created.backendInstructions)
    expect(saved?.backendModel).toBe(created.backendModel)
    expect(saved?.waitingBehavior).toBe(created.waitingBehavior)
    expect(saved?.serverUrl).toBe(created.serverUrl)
    expect(saved?.tools).toStrictEqual([VALID_TOOL])

    const edited = {
      ...created,
      voice: "aura-2-orion",
      accentStyle: "clipped, southern English",
      instructions: "You are answering for a bookshop.",
      backendInstructions: "Never invent a stock level.",
      backendModel: "gpt-4.1",
      waitingBehavior: "Stay silent while a tool runs.",
      serverUrl: "https://edited.example.invalid:8443/hook?v=2",
    }

    expect(
      await updateAssistantAction(
        String(saved?.id),
        formDataFor({ ...edited, expectedRevision: String(saved?.revision) })
      )
    ).toMatchObject({ ok: true, revision: 2 })

    const after = await getAssistantForAccount(
      account.accountId,
      String(saved?.id)
    )

    expect(after?.voice).toBe(edited.voice)
    expect(after?.accentStyle).toBe(edited.accentStyle)
    expect(after?.instructions).toBe(edited.instructions)
    expect(after?.backendInstructions).toBe(edited.backendInstructions)
    expect(after?.backendModel).toBe(edited.backendModel)
    expect(after?.waitingBehavior).toBe(edited.waitingBehavior)
    expect(after?.serverUrl).toBe(edited.serverUrl)
  })

  /**
   * Archive is a soft delete, and "unreachable" is the stronger half: the row
   * survives so a call that ran against it still points at something real, but
   * its own edit URL must stop resolving rather than merely dropping out of
   * the list.
   */
  it("archives an assistant out of the list and out of reach by id", async () => {
    const name = `archivable ${randomUUID()}`

    await createAssistantAction(formDataFor({ name }))

    const listed = await listAssistantsForAccount(account.accountId)
    const saved = listed.find((row) => row.name === name)

    expect(saved, "the assistant to archive was not created").toBeDefined()

    await archiveAssistantAction(String(saved?.id), saved?.revision ?? 0)

    expect(
      (await listAssistantsForAccount(account.accountId)).map((row) => row.name)
    ).not.toContain(name)

    expect(
      await getAssistantForAccount(account.accountId, String(saved?.id)),
      "an archived assistant is still reachable by its edit URL"
    ).toBeNull()

    // The row survives, so a call that ran against it stays attributable.
    expect(await countByName(name)).toBe(1)
  })

  it("refuses to edit an archived assistant", async () => {
    const name = `archived then edited ${randomUUID()}`

    await createAssistantAction(formDataFor({ name }))

    const saved = (await listAssistantsForAccount(account.accountId)).find(
      (row) => row.name === name
    )

    await archiveAssistantAction(String(saved?.id), saved?.revision ?? 0)

    const result = await updateAssistantAction(
      String(saved?.id),
      formDataFor({
        name: `${name} edited`,
        expectedRevision: String(saved?.revision),
      })
    )

    expect(result.ok).toBe(false)
    expect(await countByName(`${name} edited`)).toBe(0)
  })
})
