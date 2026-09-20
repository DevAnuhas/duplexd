import { describe, expect, it } from "vitest"

import { assistantSchema } from "@/lib/assistant-schema"

/**
 * The client-side schema behind the assistant editor.
 *
 * It is a **gate on the submission, not the definition of a valid assistant**.
 * The server keeps that: `readAssistantInput` re-reads every field from the
 * `FormData`, and `validateTools`/`validateServerUrl` remain the authority on
 * what may be stored. This schema exists to stop an obviously-wrong save
 * before it costs a round trip, and to put the message next to the field.
 *
 * Two consequences run through every test below.
 *
 * **It must never be stricter than the server.** A rule the client enforces and
 * the server does not is a field the operator cannot submit even though the
 * value is fine — a bug with no error message anywhere, because nothing
 * rejected it, the request simply never left. `src/lib/validate.ts` opens by
 * warning about exactly this: two implementations of one rule that agree today
 * are how a call-time rejection gets born.
 *
 * **It must not rewrite what it validates.** The editor submits the operator's
 * bytes. A schema that trimmed `name` or reformatted `tools` on the way through
 * would make the parsed output — not the textarea — the source of what gets
 * saved, silently. So the assertions below check the *output value* as often as
 * they check the verdict.
 */

/** Every field the form holds, valid, so each case differs in exactly one way. */
function validInput(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    name: "Order desk",
    voice: "aura-2",
    accentStyle: "Warm British, unhurried.",
    instructions: "Answer questions about orders.",
    backendInstructions: "Prefer lookup_order before escalating.",
    backendModel: "gpt-4.1-mini",
    waitingBehavior: 'Say "one moment" and stay quiet.',
    serverUrl: "https://api.example.com/voice",
    serverSecret: "",
    clearServerSecret: false,
    tools: "[]",
    ...overrides,
  }
}

/** The parsed value, or a failure naming the issues that came back instead. */
function expectValid(input: Record<string, unknown>): Record<string, unknown> {
  const result = assistantSchema.safeParse(input)

  if (!result.success) {
    throw new Error(
      `Expected the input to be accepted, but it was rejected: ${result.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`
    )
  }

  return result.data as Record<string, unknown>
}

/**
 * Asserts the input is rejected **and that the named field is what rejected it**.
 *
 * The field rather than the message, deliberately. Checking only that something
 * failed passes just as happily when an unrelated rule fires — a `name` case
 * that is actually being turned away by `tools` reads as coverage while proving
 * nothing, and the field is the part the UI uses to place the error anyway.
 * Message text stays the schema's to own.
 */
function expectRejectedBy(input: Record<string, unknown>, field: string): void {
  const result = assistantSchema.safeParse(input)

  if (result.success) {
    throw new Error(
      `Expected "${field}" to reject this input, but it was accepted.`
    )
  }

  const fields = result.error.issues.map((issue) => issue.path.join("."))

  expect(fields).toContain(field)
}

describe("the assistant name", () => {
  it("is accepted when it has content", () => {
    expect(expectValid(validInput()).name).toBe("Order desk")
  })

  it("is rejected when it is empty", () => {
    expectRejectedBy(validInput({ name: "" }), "name")
  })

  /**
   * A name of spaces renders as an empty heading and is indistinguishable from
   * an unnamed assistant in a call history. The server agrees — its `text()`
   * helper treats a whitespace-only field as absent — so rejecting it here is
   * the same rule applied earlier, not a stricter one.
   */
  it("is rejected when it is only whitespace", () => {
    expectRejectedBy(validInput({ name: "   " }), "name")
    expectRejectedBy(validInput({ name: "\n\t " }), "name")
  })

  /**
   * The length rule is measured on the trimmed text but the stored value keeps
   * the operator's bytes. Those two halves are tested separately below because
   * an implementation that trims to measure and then *returns the trimmed
   * string* passes a length test and quietly edits the name.
   */
  it("measures its length after trimming", () => {
    expectValid(validInput({ name: `  ${"a".repeat(120)}  ` }))
    expectRejectedBy(validInput({ name: "a".repeat(121) }), "name")
  })

  it("accepts the longest allowed name and rejects one character more", () => {
    expectValid(validInput({ name: "a".repeat(120) }))
    expectRejectedBy(validInput({ name: "a".repeat(121) }), "name")
  })

  it("accepts a single character", () => {
    expect(expectValid(validInput({ name: "x" })).name).toBe("x")
  })

  /**
   * The raw text survives. An operator who typed a trailing space gets it back;
   * the schema is not an editor.
   */
  it("keeps the name exactly as it was typed", () => {
    const typed = "  Order desk  "

    expect(expectValid(validInput({ name: typed })).name).toBe(typed)
  })

  it("is rejected when it is not a string", () => {
    expectRejectedBy(validInput({ name: 7 }), "name")
    expectRejectedBy(validInput({ name: null }), "name")
    expectRejectedBy(validInput({ name: undefined }), "name")
  })
})

describe("the server URL", () => {
  it("is accepted when blank, because it is optional", () => {
    expect(expectValid(validInput({ serverUrl: "" })).serverUrl).toBe("")
  })

  it("is accepted when it is an https URL", () => {
    const url = "https://api.example.com/voice"

    expect(expectValid(validInput({ serverUrl: url })).serverUrl).toBe(url)
  })

  it("is accepted with a port and a query", () => {
    expectValid(
      validInput({ serverUrl: "https://api.example.com:8443/voice?v=1" })
    )
  })

  it("is rejected when it is not a URL at all", () => {
    expectRejectedBy(validInput({ serverUrl: "api.example.com" }), "serverUrl")
    expectRejectedBy(validInput({ serverUrl: "not a url" }), "serverUrl")
  })

  /**
   * Anything that is not a web URL at all is turned away here, because no
   * configuration of the server could ever accept it.
   */
  it("is rejected for schemes that are not http or https", () => {
    expectRejectedBy(
      validInput({ serverUrl: "ftp://example.com/voice" }),
      "serverUrl"
    )
    expectRejectedBy(
      validInput({ serverUrl: "javascript:alert(1)" }),
      "serverUrl"
    )
    expectRejectedBy(
      validInput({ serverUrl: "file:///etc/passwd" }),
      "serverUrl"
    )
    expectRejectedBy(
      validInput({ serverUrl: "data:text/plain,x" }),
      "serverUrl"
    )
  })

  /**
   * **`http:` is accepted here even though most `http:` URLs will be refused at
   * save, and that is the point.**
   *
   * Whether a given `http:` URL may be stored depends on `ALLOW_LOOPBACK_SERVER_URL`
   * and on the address itself — knowledge that lives on the server and cannot
   * be reproduced in the browser. A client that guessed would be *stricter than
   * the server* for the cases it guessed wrong, and that failure is silent:
   * nothing rejects the value, the request simply never leaves, so there is no
   * message anywhere to explain why saving does nothing.
   *
   * So the split is: this schema decides "is this a web URL at all", and
   * `validateServerUrl` remains the sole authority on scheme and address. The
   * operator gets a real rejection with a real reason instead of a dead button.
   */
  it("accepts plain http, leaving the scheme rule to the server", () => {
    expectValid(validInput({ serverUrl: "http://example.com/voice" }))
  })

  it.each([
    "http://localhost:3000/voice",
    "http://127.0.0.1:3000/voice",
    "http://[::1]:3000/voice",
  ])("accepts the loopback URL %s, as the server may under its flag", (url) => {
    expectValid(validInput({ serverUrl: url }))
  })

  /**
   * The counterpart of the rule above, and the one that keeps it honest: a
   * private address is still *shaped* like a URL, so this schema passes it and
   * `validateServerUrl` is what refuses it. A test that only checked the
   * accepting half would not notice a client that had quietly started
   * duplicating the address rules.
   */
  it("accepts an address the server will refuse, and leaves the refusing to it", () => {
    expectValid(
      validInput({ serverUrl: "http://169.254.169.254/latest/meta-data" })
    )
    expectValid(validInput({ serverUrl: "https://10.0.0.5/voice" }))
  })

  /**
   * URL schemes are case-insensitive by specification, and the server folds the
   * scheme before testing it. A client that rejected `HTTPS://` would refuse a
   * URL the server accepts — the stricter-than-the-server failure this file
   * opens by warning about.
   */
  it("accepts an uppercase scheme, as the server does", () => {
    expectValid(validInput({ serverUrl: "HTTPS://api.example.com/voice" }))
  })

  it("keeps the URL exactly as it was typed", () => {
    const typed = "https://api.example.com/voice"

    expect(expectValid(validInput({ serverUrl: typed })).serverUrl).toBe(typed)
  })
})

describe("the tools JSON", () => {
  /**
   * The schema's entire job here is "is this a JSON array". What is *in* the
   * array is `validateTools`' business on the server, deliberately: the rules
   * for a tool are long, they involve compiling JSON Schema, and duplicating
   * them in the browser is the two-implementations trap. So a list of nonsense
   * members passes this gate and is rejected at save, with a message naming the
   * offending tool.
   */
  it("accepts an empty array", () => {
    expect(expectValid(validInput({ tools: "[]" })).tools).toBe("[]")
  })

  it("accepts an array of well-formed tools", () => {
    const raw =
      '[{"name":"lookup_order","description":"Looks it up.","parameters":{"type":"object"}}]'

    expect(expectValid(validInput({ tools: raw })).tools).toBe(raw)
  })

  it("accepts an array whose members are not tools, leaving that to the server", () => {
    expectValid(validInput({ tools: "[1,2,3]" }))
    expectValid(validInput({ tools: "[null]" }))
    expectValid(validInput({ tools: '[{"name":7}]' }))
  })

  it("is rejected when it is not JSON", () => {
    expectRejectedBy(validInput({ tools: '[{"name": "half-typed' }), "tools")
    expectRejectedBy(validInput({ tools: "not json" }), "tools")
  })

  it("is rejected when the JSON is not an array", () => {
    expectRejectedBy(validInput({ tools: "{}" }), "tools")
    expectRejectedBy(validInput({ tools: '"lookup_order"' }), "tools")
    expectRejectedBy(validInput({ tools: "null" }), "tools")
    expectRejectedBy(validInput({ tools: "42" }), "tools")
  })

  /**
   * The bytes matter more here than anywhere else in the form. The textarea is
   * submitted verbatim, so a schema that parsed and re-serialised would change
   * `2.0` to `2` and round an integer past 2^53 — silently editing a schema the
   * operator wrote by hand.
   */
  it("keeps the JSON exactly as it was typed, spacing and all", () => {
    const raw =
      '[ {"description":"Looks it up.",   "name":"lookup_order",\n' +
      '"parameters":{"type":"object","properties":{"ratio":{"default":2.0}}}} ]'

    expect(expectValid(validInput({ tools: raw })).tools).toBe(raw)
  })

  it("tolerates whitespace around the array", () => {
    expectValid(validInput({ tools: "\n  []\n" }))
  })
})

describe("the remaining fields", () => {
  /**
   * Everything else is free text the operator may leave empty. A schema that
   * required them would make the editor unusable for a half-configured
   * assistant, which is the normal state of one being set up.
   */
  const OPTIONAL_TEXT = [
    "voice",
    "accentStyle",
    "instructions",
    "backendInstructions",
    "backendModel",
    "waitingBehavior",
    "serverSecret",
  ] as const

  it.each(OPTIONAL_TEXT)("accepts %s when it is empty", (field) => {
    expectValid(validInput({ [field]: "" }))
  })

  it.each(OPTIONAL_TEXT)("keeps %s exactly as it was typed", (field) => {
    const typed = "  spaced  "

    expect(expectValid(validInput({ [field]: typed }))[field]).toBe(typed)
  })

  it.each(OPTIONAL_TEXT)("rejects %s when it is not a string", (field) => {
    expectRejectedBy(validInput({ [field]: 7 }), field)
  })

  it("takes the clear-the-secret instruction as a boolean", () => {
    expect(
      expectValid(validInput({ clearServerSecret: true })).clearServerSecret
    ).toBe(true)
    expect(
      expectValid(validInput({ clearServerSecret: false })).clearServerSecret
    ).toBe(false)
  })

  /**
   * `'on'` is what the *`FormData`* carries for a ticked box, and it is a
   * truthy string. A schema that coerced would read an unticked box's `'off'`
   * — or any other string — as "remove the stored secret", which destroys a
   * credential on a save the operator did not ask for.
   */
  it("does not coerce a string into the clear-the-secret instruction", () => {
    expectRejectedBy(
      validInput({ clearServerSecret: "on" }),
      "clearServerSecret"
    )
    expectRejectedBy(
      validInput({ clearServerSecret: "false" }),
      "clearServerSecret"
    )
    expectRejectedBy(
      validInput({ clearServerSecret: undefined }),
      "clearServerSecret"
    )
  })
})

describe("reporting more than one problem at once", () => {
  /**
   * The editor places each message beside its field, so a form with three
   * mistakes has to come back with three issues rather than stopping at the
   * first. An operator who fixes the name and is then told about the URL, and
   * then about the tools, does three round trips to learn what one would have
   * told them.
   */
  it("names every field that is wrong", () => {
    const result = assistantSchema.safeParse(
      validInput({ name: "", serverUrl: "not a url", tools: "{}" })
    )

    expect(result.success).toBe(false)

    if (result.success) {
      return
    }

    const fields = new Set(
      result.error.issues.map((issue) => issue.path.join("."))
    )

    expect(fields).toContain("name")
    expect(fields).toContain("serverUrl")
    expect(fields).toContain("tools")
  })
})
