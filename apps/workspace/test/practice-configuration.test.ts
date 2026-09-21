import { describe, expect, it } from "vitest"

import {
  PRACTICE_COMPILER_VERSION,
  compilePracticeConfiguration,
  fingerprintToolInputSchema,
  validatePracticeArguments,
  validateRunnableAssistant,
  type CompilePracticeInput,
  type RunnableAssistant,
} from "@/practice/configuration"

import { PRACTICE_TOOL, practiceSampleDefinition } from "./helpers/practice.ts"

function runnableAssistant(
  overrides: Partial<RunnableAssistant> = {}
): RunnableAssistant {
  return {
    id: "assistant-practice",
    revision: 7,
    voice: "marin",
    accentStyle: "Warm and direct.",
    instructions: "Answer questions about the sample property.",
    backendInstructions: "Use the declared lookup tool.",
    backendModel: "gpt-5.6-luna",
    waitingBehavior: "Briefly acknowledge tool work.",
    tools: [structuredClone(PRACTICE_TOOL)],
    serverUrl: "https://customer.example.invalid/must-not-be-used",
    hasServerSecret: true,
    ...overrides,
  }
}

function compileInput(
  overrides: Partial<CompilePracticeInput> = {}
): CompilePracticeInput {
  const assistant = overrides.assistant ?? runnableAssistant()
  const fingerprint = fingerprintToolInputSchema(PRACTICE_TOOL)

  return {
    assistant,
    baseRevision: assistant.revision,
    source: "saved",
    samples: [practiceSampleDefinition(fingerprint)],
    sampleRevision: 3,
    scenario: { transport: "success", overrides: {} },
    scenarioRevision: 2,
    ...overrides,
  }
}

describe("mode-specific runnable validation", () => {
  it("keeps customer connection requirements out of Practice", () => {
    const disconnected = runnableAssistant({
      serverUrl: null,
      hasServerSecret: false,
    })

    expect(validateRunnableAssistant(disconnected, "practice")).toStrictEqual(
      []
    )
    expect(validateRunnableAssistant(disconnected, "integration")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "serverUrl" }),
        expect.objectContaining({ field: "serverSecret" }),
      ])
    )
  })

  it("rejects unsupported deployed voice and model capabilities by field", () => {
    const issues = validateRunnableAssistant(
      runnableAssistant({
        voice: "future-voice",
        backendModel: "future-model",
      }),
      "practice"
    )

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "voice" }),
        expect.objectContaining({ field: "backendModel" }),
      ])
    )
  })

  it("leaves an incomplete editable draft representable but refuses to run it", () => {
    const draft = runnableAssistant({
      voice: null,
      instructions: " ",
      backendInstructions: null,
      backendModel: null,
    })

    expect(validateRunnableAssistant(draft, "practice")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "voice" }),
        expect.objectContaining({ field: "instructions" }),
        expect.objectContaining({ field: "backendInstructions" }),
        expect.objectContaining({ field: "backendModel" }),
      ])
    )
  })
})

describe("tool input-schema fingerprints", () => {
  it("is canonical across object-key order and excludes descriptions", () => {
    const reordered = {
      name: PRACTICE_TOOL.name,
      description: "A changed description does not invalidate authored data.",
      parameters: {
        required: ["property"],
        properties: { property: { type: "string" } },
        additionalProperties: false,
        type: "object",
      },
    }

    expect(fingerprintToolInputSchema(reordered)).toBe(
      fingerprintToolInputSchema(PRACTICE_TOOL)
    )
  })

  it("changes on a rename or input-schema change", () => {
    const original = fingerprintToolInputSchema(PRACTICE_TOOL)

    expect(
      fingerprintToolInputSchema({ ...PRACTICE_TOOL, name: "renamed_tool" })
    ).not.toBe(original)
    expect(
      fingerprintToolInputSchema({
        ...PRACTICE_TOOL,
        parameters: {
          ...PRACTICE_TOOL.parameters,
          properties: { property: { type: "number" } },
        },
      })
    ).not.toBe(original)
  })
})

describe("immutable Practice compilation", () => {
  it("returns a stale-revision result instead of compiling against changed state", () => {
    expect(
      compilePracticeConfiguration(
        compileInput({
          assistant: runnableAssistant({ revision: 8 }),
          baseRevision: 7,
        })
      )
    ).toStrictEqual({ kind: "assistant_changed", currentRevision: 8 })
  })

  it("rejects customer connection and hidden fields in a preview", () => {
    const result = compilePracticeConfiguration(
      compileInput({
        source: "preview",
        preview: {
          serverUrl: "https://trap.example.invalid/never",
          serverSecret: "must-not-cross-the-boundary",
          accountId: "other-account",
        },
      })
    )

    expect(result).toMatchObject({ kind: "invalid" })
    if (result.kind !== "invalid") throw new Error("expected invalid preview")
    expect(result.issues.map((issue) => issue.field).sort()).toStrictEqual([
      "accountId",
      "serverSecret",
      "serverUrl",
    ])
  })

  it("freezes the authored configuration without copying a customer URL or secret", () => {
    const assistant = runnableAssistant()
    const samples = [
      practiceSampleDefinition(fingerprintToolInputSchema(PRACTICE_TOOL)),
    ]
    const result = compilePracticeConfiguration(
      compileInput({ assistant, samples, source: "preview", preview: {} })
    )

    expect(result.kind).toBe("ready")
    if (result.kind !== "ready") throw new Error("expected ready snapshot")

    expect(result.snapshot).toMatchObject({
      assistantId: assistant.id,
      baseAssistantRevision: assistant.revision,
      configSource: "preview",
      compilerVersion: PRACTICE_COMPILER_VERSION,
      sampleRevision: 3,
      scenarioRevision: 2,
    })
    expect(result.snapshot.instructions).toContain("synthetic sample data")
    expect(JSON.stringify(result.snapshot)).not.toContain(
      String(assistant.serverUrl)
    )
    expect(result.snapshot).not.toHaveProperty("serverUrl")
    expect(result.snapshot).not.toHaveProperty("serverSecret")

    ;(
      assistant.tools as Array<{ parameters: Record<string, unknown> }>
    )[0]!.parameters.type = "array"
    samples[0]!.defaultResult = {
      property: "Changed later",
      checkoutTime: "Changed later",
    }

    expect(result.snapshot.tools[0]?.parameters.type).toBe("object")
    expect(result.snapshot.samples[0]?.defaultResult).toStrictEqual({
      property: "Sample Cottage",
      checkoutTime: "11:00 AM",
    })
  })

  it("keeps the digest deterministic and sensitive to authored scenarios", () => {
    const first = compilePracticeConfiguration(compileInput())
    const repeat = compilePracticeConfiguration(compileInput())
    const changed = compilePracticeConfiguration(
      compileInput({ scenario: { transport: "slow", overrides: {} } })
    )

    expect(first.kind).toBe("ready")
    expect(repeat.kind).toBe("ready")
    expect(changed.kind).toBe("ready")
    if (
      first.kind !== "ready" ||
      repeat.kind !== "ready" ||
      changed.kind !== "ready"
    ) {
      throw new Error("expected ready snapshots")
    }
    expect(first.snapshot.configDigest).toBe(repeat.snapshot.configDigest)
    expect(changed.snapshot.configDigest).not.toBe(first.snapshot.configDigest)
  })
})

describe("sample coverage and arguments", () => {
  it("names missing and stale tool mappings", () => {
    const missing = compilePracticeConfiguration(compileInput({ samples: [] }))
    const stale = compilePracticeConfiguration(
      compileInput({
        samples: [
          {
            ...practiceSampleDefinition("stale-fingerprint"),
            inputSchemaFingerprint: "stale-fingerprint",
            reviewedFingerprint: "stale-fingerprint",
          },
        ],
      })
    )

    expect(missing).toMatchObject({
      kind: "invalid",
      issues: [
        expect.objectContaining({
          message: expect.stringContaining(PRACTICE_TOOL.name),
        }),
      ],
    })
    expect(stale).toMatchObject({
      kind: "invalid",
      issues: [
        expect.objectContaining({
          message: expect.stringContaining(PRACTICE_TOOL.name),
        }),
      ],
    })
  })

  it("falls back to the explicit default when a named override no longer exists", () => {
    const result = compilePracticeConfiguration(
      compileInput({
        scenario: {
          transport: "success",
          overrides: { [PRACTICE_TOOL.name]: "removed-override" },
        },
      })
    )

    expect(result.kind).toBe("ready")
    if (result.kind !== "ready") throw new Error("expected ready snapshot")
    expect(result.snapshot.scenario.overrides).toStrictEqual({})
    expect(result.snapshot.samples[0]?.defaultResult).toStrictEqual({
      property: "Sample Cottage",
      checkoutTime: "11:00 AM",
    })
  })

  it("validates invocation arguments against the frozen input schema", () => {
    expect(
      validatePracticeArguments(PRACTICE_TOOL, { property: "sample-cottage" })
    ).toBe(true)
    expect(validatePracticeArguments(PRACTICE_TOOL, {})).toBe(false)
    expect(
      validatePracticeArguments(PRACTICE_TOOL, {
        property: "sample-cottage",
        injected: true,
      })
    ).toBe(false)
  })
})
