import { describe, expect, it } from "vitest"

import { fingerprintToolInputSchema } from "@/practice/configuration"
import {
  MAX_SAMPLE_DEFINITIONS_BYTES,
  MAX_SAMPLE_RESULT_BYTES,
  parsePracticeSampleDefinitions,
  practiceToolUrl,
} from "@/practice/samples"

import { PRACTICE_TOOL, practiceSampleDefinition } from "./helpers/practice.ts"

function validDefinition() {
  return practiceSampleDefinition(fingerprintToolInputSchema(PRACTICE_TOOL))
}

describe("Practice sample parsing", () => {
  it("keeps JSON scalar, array, object, and null results", () => {
    const values = [null, true, 17, "sample", ["one", 2], { ok: true }]

    for (const value of values) {
      const parsed = parsePracticeSampleDefinitions(
        [{ ...validDefinition(), defaultResult: value }],
        [PRACTICE_TOOL]
      )

      expect(parsed).toMatchObject({
        ok: true,
        definitions: [expect.objectContaining({ defaultResult: value })],
      })
    }
  })

  it("rejects unknown fields instead of retaining execution controls", () => {
    const parsed = parsePracticeSampleDefinitions(
      [
        {
          ...validDefinition(),
          destination: "https://customer.example.invalid/trap",
          credential: "must-not-be-retained",
        },
      ],
      [PRACTICE_TOOL]
    )

    expect(parsed).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ field: "definitions" })],
    })
    expect(JSON.stringify(parsed)).not.toContain("must-not-be-retained")
  })

  it("rejects missing, duplicate, renamed, and stale tool mappings", () => {
    const fingerprint = fingerprintToolInputSchema(PRACTICE_TOOL)
    const valid = practiceSampleDefinition(fingerprint)

    expect(
      parsePracticeSampleDefinitions(
        [{ ...valid, toolName: "renamed_tool" }],
        [PRACTICE_TOOL]
      ).ok
    ).toBe(false)
    expect(
      parsePracticeSampleDefinitions([valid, valid], [PRACTICE_TOOL]).ok
    ).toBe(false)
    expect(
      parsePracticeSampleDefinitions(
        [{ ...valid, reviewedFingerprint: "stale" }],
        [PRACTICE_TOOL]
      ).ok
    ).toBe(false)
    expect(
      parsePracticeSampleDefinitions(
        [{ ...valid, inputSchemaFingerprint: "stale" }],
        [PRACTICE_TOOL]
      ).ok
    ).toBe(false)
  })

  it("rejects duplicate or malformed named overrides", () => {
    const definition = validDefinition()

    expect(
      parsePracticeSampleDefinitions(
        [
          {
            ...definition,
            overrides: [
              { name: "unavailable", result: null },
              { name: "unavailable", result: "duplicate" },
            ],
          },
        ],
        [PRACTICE_TOOL]
      ).ok
    ).toBe(false)
    expect(
      parsePracticeSampleDefinitions(
        [
          {
            ...definition,
            overrides: [{ name: "spaces are invalid", result: null }],
          },
        ],
        [PRACTICE_TOOL]
      ).ok
    ).toBe(false)
  })

  it("enforces the per-result and aggregate byte bounds", () => {
    const tooLargeResult = "x".repeat(MAX_SAMPLE_RESULT_BYTES)
    const resultBound = parsePracticeSampleDefinitions(
      [{ ...validDefinition(), defaultResult: tooLargeResult }],
      [PRACTICE_TOOL]
    )

    expect(resultBound.ok).toBe(false)

    const aggregateBound = parsePracticeSampleDefinitions(
      [
        {
          ...validDefinition(),
          overrides: Array.from({ length: 5 }, (_, index) => ({
            name: `variant-${index}`,
            result: "x".repeat(MAX_SAMPLE_RESULT_BYTES - 512),
          })),
        },
      ],
      [PRACTICE_TOOL]
    )

    expect(
      Buffer.byteLength(JSON.stringify(aggregateBound), "utf8")
    ).toBeLessThan(MAX_SAMPLE_DEFINITIONS_BYTES)
    expect(aggregateBound.ok).toBe(false)
  })
})

describe("server-owned Practice tool URL", () => {
  it("replaces customer-controlled path, query, and fragment", () => {
    expect(
      practiceToolUrl(
        "https://workspace.example.invalid/customer/path?secret=canary#fragment",
        "call/with spaces"
      )
    ).toBe(
      "https://workspace.example.invalid/v1/practice/calls/call%2Fwith%20spaces/tools"
    )
  })
})
