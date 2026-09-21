import { describe, expect, it } from "vitest"

import {
  compilePracticeConfiguration,
  fingerprintToolInputSchema,
} from "@/practice/configuration"
import {
  RILEY_PRACTICE_TEMPLATE_VERSION,
  rileyPracticeTemplate,
} from "@/practice/riley"
import { parsePracticeSampleDefinitions } from "@/practice/samples"
import { rileyAssistantTemplate } from "@/lib/riley"

import { rileyDemo } from "../scripts/riley-demo.ts"

describe("versioned Riley Practice pack", () => {
  it("shares one generic fictional assistant authority with the seed", () => {
    const authority = rileyAssistantTemplate()
    const seeded = rileyDemo()
    const practice = rileyPracticeTemplate()

    expect(seeded).toStrictEqual(authority)
    expect(practice.assistant).toStrictEqual(authority)
    expect(JSON.stringify(authority)).not.toMatch(/Rushmore|Boring Host/i)
    expect(authority.serverUrl).toBeNull()
    expect(authority).not.toHaveProperty("serverSecret")

    expect(authority).not.toHaveProperty("samples")
    expect(practice.samples).not.toHaveLength(0)
    expect(authority.instructions).not.toContain("Practice mode is active")
  })

  it("is pure, disconnected, fictional, and independently cloned", () => {
    const first = rileyPracticeTemplate()
    const second = rileyPracticeTemplate()

    expect(first.version).toBe(RILEY_PRACTICE_TEMPLATE_VERSION)
    expect(first.assistant.serverUrl).toBeNull()
    expect(first.assistant).not.toHaveProperty("serverSecret")
    expect(JSON.stringify(first)).toContain("fictional")
    expect(JSON.stringify(first)).toContain("synthetic")

    const firstTool = first.assistant.tools[0]
    const secondTool = second.assistant.tools[0]
    expect(firstTool).toBeDefined()
    expect(secondTool).toBeDefined()
    ;(firstTool as { description: string }).description = "mutated caller copy"
    expect(secondTool?.description).not.toBe("mutated caller copy")
  })

  it("keeps complete reviewed coverage for every declared tool", () => {
    const template = rileyPracticeTemplate()
    const parsed = parsePracticeSampleDefinitions(
      template.samples,
      template.assistant.tools
    )

    expect(parsed.ok).toBe(true)
    expect(template.samples).toHaveLength(template.assistant.tools.length)
    for (const tool of template.assistant.tools) {
      const fingerprint = fingerprintToolInputSchema(tool)
      expect(template.samples).toContainEqual(
        expect.objectContaining({
          toolName: tool.name,
          inputSchemaFingerprint: fingerprint,
          reviewedFingerprint: fingerprint,
        })
      )
    }
  })

  it.each([
    ["property information", "success", undefined],
    ["information unavailable", "success", "unavailable"],
    ["slow response", "slow", undefined],
    ["tool failure", "failure", undefined],
  ] as const)("compiles the %s scenario", (_label, transport, override) => {
    const template = rileyPracticeTemplate()
    const toolName = template.assistant.tools[0]?.name
    expect(toolName).toBeDefined()
    if (toolName === undefined) throw new Error("Riley needs a tool")
    const result = compilePracticeConfiguration({
      assistant: {
        id: "riley-assistant",
        revision: 1,
        ...template.assistant,
      },
      baseRevision: 1,
      source: "saved",
      samples: template.samples,
      sampleRevision: 1,
      scenario: {
        transport,
        overrides: override === undefined ? {} : { [toolName]: override },
      },
      scenarioRevision: 1,
    })

    expect(result.kind).toBe("ready")
    if (result.kind !== "ready") throw new Error("expected ready Riley pack")
    expect(result.snapshot.scenario).toStrictEqual({
      transport,
      overrides: override === undefined ? {} : { [toolName]: override },
    })
    expect(result.snapshot.instructions).toContain("Practice mode is active")
    expect(template.assistant.instructions).not.toContain(
      "Practice mode is active"
    )
  })
})
