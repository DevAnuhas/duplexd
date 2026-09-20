import { randomUUID } from "node:crypto"

import { describe, expect, it } from "vitest"

import { validateTools } from "@/lib/validate"

/**
 * Tool-list validation, in the OpenAI function format.
 *
 * This is where the ticket said the sprint would be hardest, and the reason is
 * the failure mode rather than the rules: a customer writes JSON Schema by
 * hand, gets it subtly wrong, saves happily, and finds out when a voice call
 * silently does nothing with a caller on the line. So the rules are checked at
 * save, and every message has to say **which** tool is wrong — "invalid tool
 * list" against twelve tools tells the customer nothing.
 *
 * Every assertion below about a message naming its tool is load-bearing. A
 * change that made the rejection generic would still reject the right lists,
 * and would still pass a test that only counted issues.
 */

/** A tool that is valid in every respect, so cases differ in exactly one way. */
function validTool(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    name: "lookup_order",
    description: "Looks up an order by its reference.",
    parameters: {
      type: "object",
      properties: { reference: { type: "string" } },
      required: ["reference"],
    },
    ...overrides,
  }
}

describe("a valid tool list", () => {
  it("is accepted", () => {
    expect(validateTools([validTool()])).toStrictEqual([])
  })

  it("is accepted with several tools", () => {
    expect(
      validateTools([
        validTool(),
        validTool({ name: "cancel-order", description: "Cancels an order." }),
        validTool({ name: "A1_b-2", description: "Does a thing." }),
      ])
    ).toStrictEqual([])
  })

  it("accepts parameters with no properties at all", () => {
    expect(
      validateTools([validTool({ parameters: { type: "object" } })])
    ).toStrictEqual([])
  })

  it.each([
    ["an empty list", []],
    ["undefined", undefined],
    ["null", null],
  ])("accepts %s — an assistant need not have tools", (_label, value) => {
    expect(validateTools(value)).toStrictEqual([])
  })

  it.each([
    ["an object", { name: "x" }],
    ["a string", "[]"],
    ["a number", 1],
  ])("rejects %s, which is not a list", (_label, value) => {
    const issues = validateTools(value)

    expect(issues).toHaveLength(1)
    expect(issues[0]?.field).toBe("tools")
  })
})

describe("the name rule", () => {
  const sixtyFour = "a".repeat(64)

  it.each([
    ["a single character", "a"],
    ["underscores", "lookup_order"],
    ["hyphens", "lookup-order"],
    ["digits", "lookup2"],
    ["sixty-four characters", sixtyFour],
  ])("accepts %s", (_label, name) => {
    expect(validateTools([validTool({ name })])).toStrictEqual([])
  })

  it.each([
    ["the empty string", ""],
    ["sixty-five characters", `${sixtyFour}a`],
    ["a space", "lookup order"],
    ["a dot", "lookup.order"],
    ["a slash", "lookup/order"],
    ["a non-ASCII character", "lookup_ordér"],
    ["a number rather than a string", 42],
    ["a missing name", undefined],
  ])("rejects %s", (_label, name) => {
    const tool = validTool()
    if (name === undefined) {
      delete tool.name
    } else {
      tool.name = name
    }

    const issues = validateTools([tool])

    expect(issues.length).toBeGreaterThan(0)
    expect(issues.some((issue) => /name/i.test(issue.message))).toBe(true)
  })
})

describe("the description rule", () => {
  it.each([
    ["a missing description", undefined],
    ["an empty description", ""],
    ["a whitespace-only description", "   "],
    ["a non-string description", 7],
  ])("rejects %s", (_label, description) => {
    const tool = validTool()
    if (description === undefined) {
      delete tool.description
    } else {
      tool.description = description
    }

    const issues = validateTools([tool])

    expect(issues).toHaveLength(1)
    expect(issues[0]?.message).toContain("lookup_order")
    expect(issues[0]?.message).toMatch(/description/i)
  })
})

describe("the parameters rule", () => {
  it.each([
    ["missing", undefined],
    ["null", null],
    ["a list", []],
    ["a string", '{"type":"object"}'],
    ["a number", 3],
    ["a boolean", true],
  ])("rejects parameters that are %s", (_label, parameters) => {
    const tool = validTool()
    if (parameters === undefined) {
      delete tool.parameters
    } else {
      tool.parameters = parameters
    }

    const issues = validateTools([tool])

    expect(issues).toHaveLength(1)
    expect(issues[0]?.message).toContain("lookup_order")
  })

  /**
   * `type: "object"` specifically, not merely "some schema". The provider
   * requires a top-level object for a function's arguments, and a schema that
   * describes a string or an array would be accepted by a bare JSON Schema
   * check and then fail at call time, which is the outcome this whole file
   * exists to prevent.
   */
  it.each([
    ["string", { type: "string" }],
    ["array", { type: "array", items: { type: "string" } }],
    ["number", { type: "number" }],
    ["absent", { properties: { x: { type: "string" } } }],
  ])("rejects parameters whose type is %s", (_label, parameters) => {
    const issues = validateTools([validTool({ parameters })])

    expect(issues).toHaveLength(1)
    expect(issues[0]?.message).toContain("lookup_order")
    expect(issues[0]?.message).toContain("object")
  })

  /**
   * "Valid JSON Schema" is defined operationally as "Ajv compiles it", because
   * two implementations can disagree about the phrase and then disagree about
   * which tool lists to accept. Each of these has `type: "object"` and is
   * still not a schema — they are the shapes a customer writing one by hand
   * actually produces.
   */
  it.each([
    [
      "an unknown type in a property",
      { type: "object", properties: { x: { type: "nonsense" } } },
    ],
    [
      "required as a string rather than a list",
      { type: "object", required: "reference" },
    ],
    ["properties as a string", { type: "object", properties: "reference" }],
    [
      "a non-numeric minimum",
      { type: "object", properties: { x: { minimum: "five" } } },
    ],
    [
      "additionalProperties as a number",
      { type: "object", additionalProperties: 5 },
    ],
  ])("rejects %s, which does not compile", (_label, parameters) => {
    const issues = validateTools([validTool({ parameters })])

    expect(issues).toHaveLength(1)
    expect(issues[0]?.field).toBe("tools")
    expect(issues[0]?.message).toContain("lookup_order")
  })
})

/**
 * The contract's requirement, asserted on its own rather than as a by-product.
 *
 * A rejection that does not say which tool is wrong sends the customer to read
 * twelve JSON blobs. These tests fail if the tool's name is dropped from the
 * message, which no count-based assertion would notice.
 */
describe("every message identifies the offending tool", () => {
  it("names the tool when the tool has a usable name", () => {
    const issues = validateTools([
      validTool({ name: "first_tool" }),
      validTool({ name: "second_tool" }),
      validTool({
        name: "broken_tool",
        parameters: { type: "object", required: "x" },
      }),
      validTool({ name: "fourth_tool" }),
    ])

    expect(issues).toHaveLength(1)
    expect(issues[0]?.message).toContain("broken_tool")
    expect(issues[0]?.message).not.toContain("first_tool")
    expect(issues[0]?.message).not.toContain("fourth_tool")
  })

  /**
   * When the name is the broken part there is nothing to quote, so the message
   * falls back to the tool's position in the list. Either form identifies it;
   * neither being present would not.
   */
  it("falls back to the position when the name itself is unusable", () => {
    const tool = validTool()
    delete tool.name

    const issues = validateTools([
      validTool({ name: "fine_one" }),
      validTool({ name: "fine_two" }),
      tool,
    ])

    expect(issues.length).toBeGreaterThan(0)

    for (const issue of issues) {
      expect(issue.message, `"${issue.message}" identifies no tool`).toContain(
        "tool 3"
      )
    }
  })

  it("names each offender when several tools are wrong", () => {
    const issues = validateTools([
      validTool({ name: "alpha_tool", description: "" }),
      validTool({ name: "beta_tool" }),
      validTool({ name: "gamma_tool", parameters: { type: "string" } }),
    ])

    expect(issues).toHaveLength(2)

    const messages = issues.map((issue) => issue.message).join("\n")

    expect(messages).toContain("alpha_tool")
    expect(messages).toContain("gamma_tool")
    expect(messages).not.toContain("beta_tool")
  })

  it("identifies a tool that is not an object at all by its position", () => {
    const issues = validateTools([validTool(), "not a tool"])

    expect(issues).toHaveLength(1)
    expect(issues[0]?.message).toContain("tool 2")
  })
})

/**
 * The format is stored unchanged, so validation must not be the place a
 * translation layer sneaks in: what goes in is what a customer already knows
 * from Vapi and OpenAI, and what the agent hands the model.
 */
describe("the stored format", () => {
  it("does not mutate the tool list it validates", () => {
    const tools = [validTool(), validTool({ name: "second_tool" })]
    const before = JSON.stringify(tools)

    validateTools(tools)

    expect(JSON.stringify(tools)).toBe(before)
  })

  it("accepts extra provider fields rather than stripping them", () => {
    expect(
      validateTools([validTool({ strict: true, extra: { anything: 1 } })])
    ).toStrictEqual([])
  })
})

/**
 * A schema carrying `$id`, saved twice.
 *
 * `ajv.compile` does not merely check a schema, it **registers** it under its
 * `$id`, and a second registration of the same `$id` throws. That turns a
 * perfectly valid tool list into one the workspace rejects on every save after
 * the first, for the life of the process — and `$id` is not exotic: it is
 * exactly what someone hand-writing JSON Schema from the specification puts at
 * the top.
 *
 * **Parsing fresh on each call is the whole test.** Ajv keeps an identity
 * cache, so compiling the *same object* twice is absorbed and shows nothing;
 * it is only when the two objects are structurally equal but distinct that the
 * `$id` collision surfaces. Every real save parses the form's JSON afresh, so
 * distinct objects is what production actually does — which is why this
 * reproduces in the product and not in a naive reproduction.
 *
 * `validateSchema` answers the question being asked and registers nothing.
 */
describe("a schema with an $id", () => {
  /** Serialised once, parsed per call — two structurally equal, distinct objects. */
  const serialised = JSON.stringify([
    {
      name: "lookup_order",
      description: "Looks up an order by its reference.",
      parameters: {
        $id: `https://schemas.example.invalid/${randomUUID()}`,
        type: "object",
        properties: { reference: { type: "string" } },
        required: ["reference"],
      },
    },
  ])

  it("is accepted the first time", () => {
    expect(validateTools(JSON.parse(serialised))).toStrictEqual([])
  })

  it("is still accepted the second time, parsed fresh", () => {
    expect(validateTools(JSON.parse(serialised))).toStrictEqual([])
    expect(validateTools(JSON.parse(serialised))).toStrictEqual([])
  })

  /**
   * Two different customers using the same `$id` must not collide either. The
   * validator instance is module-level, so its registry is shared across every
   * account in the process — one account burning an `$id` for another is the
   * multi-tenant form of the same bug.
   */
  it("does not let one tool list burn an $id for a different one", () => {
    const shared = `https://schemas.example.invalid/${randomUUID()}`
    const listFor = (name: string) =>
      JSON.parse(
        JSON.stringify([
          {
            name,
            description: "Shares an $id with another account’s tool.",
            parameters: { $id: shared, type: "object" },
          },
        ])
      )

    expect(validateTools(listFor("first_account_tool"))).toStrictEqual([])
    expect(validateTools(listFor("second_account_tool"))).toStrictEqual([])
  })
})

/**
 * Two tools with the same name.
 *
 * **Currently red — the rule does not exist yet.** Included because the defect
 * does not depend on any provider's error handling, which is the part I could
 * not verify from here.
 *
 * A tool list with two entries called `lookup_order` is ambiguous *by
 * construction*: when the model emits a tool call named `lookup_order`, there
 * is no fact of the matter about which definition it meant, and nothing
 * downstream can recover the customer's intent. Whether the provider rejects
 * the list on submission or silently keeps the last one, the customer finds
 * out when a call behaves oddly — which is contract item 26's named failure
 * mode, "rejected at save, never at call time", and the exact thing the ticket
 * says this validator exists to prevent.
 *
 * It is also the cheapest possible check: the names are already being
 * validated one at a time, and this is the one property that can only be seen
 * by looking at the list as a whole.
 */
describe("duplicate tool names", () => {
  const named = (name: string) => ({
    name,
    description: "Looks up an order by its reference.",
    parameters: { type: "object" as const },
  })

  it("are rejected, naming the duplicate", () => {
    const issues = validateTools([named("lookup_order"), named("lookup_order")])

    expect(issues.length, "two tools may not share a name").toBeGreaterThan(0)
    expect(issues.map((issue) => issue.message).join("\n")).toContain(
      "lookup_order"
    )
  })

  it("are rejected when they are not adjacent", () => {
    const issues = validateTools([
      named("alpha_tool"),
      named("beta_tool"),
      named("alpha_tool"),
    ])

    expect(issues.length).toBeGreaterThan(0)
    expect(issues.map((issue) => issue.message).join("\n")).toContain(
      "alpha_tool"
    )
  })

  /** The control: distinct names stay acceptable, so the rule is not over-broad. */
  it("do not fire on distinct names", () => {
    expect(
      validateTools([
        named("alpha_tool"),
        named("beta_tool"),
        named("gamma_tool"),
      ])
    ).toStrictEqual([])
  })

  /**
   * One issue per repeated name, not one per repetition. Twelve tools sharing
   * a name is one mistake, and eleven identical messages is a worse way to be
   * told about it than one.
   */
  it("report a repeated name once however many times it repeats", () => {
    const issues = validateTools(
      Array.from({ length: 12 }, () => named("lookup_order"))
    )

    expect(issues).toHaveLength(1)
    expect(issues[0]?.message).toContain("lookup_order")
  })

  it("report each repeated name separately when several repeat", () => {
    const issues = validateTools([
      named("alpha_tool"),
      named("alpha_tool"),
      named("beta_tool"),
      named("beta_tool"),
      named("gamma_tool"),
    ])

    expect(issues).toHaveLength(2)

    const messages = issues.map((issue) => issue.message).join("\n")

    expect(messages).toContain("alpha_tool")
    expect(messages).toContain("beta_tool")
    expect(messages).not.toContain("gamma_tool")
  })

  /**
   * Compared exactly, with no case folding, and that is a deliberate choice
   * rather than an oversight: `lookup_order` and `Lookup_Order` are two
   * distinct identifiers to a provider, so folding here would reject a tool
   * list that works. Pinned so a future "helpful" case-insensitive comparison
   * is a decision somebody makes on purpose.
   */
  it("are compared exactly, so names differing only in case are distinct", () => {
    expect(
      validateTools([named("lookup_order"), named("Lookup_Order")])
    ).toStrictEqual([])
  })

  /**
   * A name that is both malformed and repeated earns **one** complaint, not
   * two overlapping ones. A malformed name never enters the seen-names set, so
   * the customer is told the thing they can act on — fix the name — rather than
   * also being told it collides with the other broken one.
   */
  it("do not pile a duplicate complaint on top of a malformed name", () => {
    const issues = validateTools([
      { ...named("lookup order"), name: "lookup order" },
      { ...named("lookup order"), name: "lookup order" },
    ])

    expect(issues).toHaveLength(2)

    for (const issue of issues) {
      expect(issue.message).toMatch(/needs a name/i)
      expect(issue.message).not.toMatch(/must be unique/i)
    }
  })

  /**
   * And the sibling: a valid name repeated alongside an unrelated malformed
   * one still reports both problems, so the case above is not passing because
   * the duplicate rule stopped working.
   */
  it("still report a duplicate when an unrelated tool is also malformed", () => {
    const issues = validateTools([
      named("lookup_order"),
      named("lookup_order"),
      { ...named("bad"), name: "bad name" },
    ])

    const messages = issues.map((issue) => issue.message).join("\n")

    expect(messages).toMatch(/must be unique/i)
    expect(messages).toContain("lookup_order")
    expect(messages).toMatch(/needs a name/i)
  })
})
