import { beforeEach, describe, expect, it, vi } from "vitest"

const boundary = vi.hoisted(() => ({
  requireAccount: vi.fn(),
  readAssistant: vi.fn(),
  getDb: vi.fn(() => {
    throw new Error(
      "Preflight must not access the database beyond its safe read"
    )
  }),
}))
vi.mock("@/lib/account", () => ({
  requireCurrentAccount: boundary.requireAccount,
}))
vi.mock("@/data/assistants", () => ({
  getAssistantPracticeSourceForAccount: boundary.readAssistant,
}))
vi.mock("@/db/client", () => ({ getDb: boundary.getDb }))

import { validateAssistantDraft } from "@/app/(app)/assistants/draft-actions"
import { fingerprintToolInputSchema } from "@/practice/configuration"
import { rileyPracticeTemplate } from "@/practice/riley"

function fixture() {
  const template = rileyPracticeTemplate()
  return {
    assistant: {
      ...template.assistant,
      id: "synthetic-assistant",
      revision: 3,
    },
    request: {
      assistantId: "synthetic-assistant",
      baseRevision: 3,
      source: "saved" as const,
      samples: template.samples,
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  boundary.requireAccount.mockResolvedValue({ accountId: "session-account" })
  boundary.readAssistant.mockResolvedValue(fixture().assistant)
})

describe("authenticated read-only Sandbox draft preflight", () => {
  it("uses the authenticated account for its safe read and returns real tool fingerprints", async () => {
    const { assistant, request } = fixture()
    const result = await validateAssistantDraft(request)
    expect(boundary.requireAccount).toHaveBeenCalledOnce()
    expect(boundary.readAssistant).toHaveBeenCalledExactlyOnceWith(
      "session-account",
      request.assistantId
    )
    expect(result).toEqual({
      issues: [],
      tools: assistant.tools.map((tool) => ({
        name: tool.name,
        fingerprint: fingerprintToolInputSchema(tool),
        parameters: tool.parameters,
      })),
    })
    expect(boundary.getDb).not.toHaveBeenCalled()
  })

  it("does not read assistant data when authentication fails", async () => {
    const unauthenticated = new Error("Synthetic unauthenticated session")
    boundary.requireAccount.mockRejectedValueOnce(unauthenticated)
    await expect(validateAssistantDraft(fixture().request)).rejects.toBe(
      unauthenticated
    )
    expect(boundary.readAssistant).not.toHaveBeenCalled()
  })

  it("does not permit a supplied account to replace the authenticated scope", async () => {
    const result = await validateAssistantDraft({
      ...fixture().request,
      ...{ accountId: "foreign-account" },
    })
    expect(result.issues).toEqual([
      { field: "draft", message: "The draft request is invalid." },
    ])
    expect(boundary.readAssistant).not.toHaveBeenCalled()
  })

  it("reports unavailable assistants without leaking account or assistant details", async () => {
    boundary.readAssistant.mockResolvedValueOnce(null)
    const result = await validateAssistantDraft({
      ...fixture().request,
      assistantId: "foreign-or-missing-assistant",
    })
    expect(boundary.readAssistant).toHaveBeenCalledExactlyOnceWith(
      "session-account",
      "foreign-or-missing-assistant"
    )
    expect(result).toEqual({
      tools: [],
      issues: [
        { field: "draft", message: "This assistant is no longer available." },
      ],
    })
  })

  it.each(["name", "serverUrl", "serverSecret", "accountId", "unknown"])(
    "rejects the forbidden preview field %s before reading an assistant",
    async (field) => {
      const result = await validateAssistantDraft({
        ...fixture().request,
        source: "preview",
        preview: { [field]: "synthetic-value-must-not-leak" },
      })
      expect(result).toEqual({
        tools: [],
        issues: [
          {
            field: "draft",
            message:
              "Only conversation, voice, backend model and tool fields may be previewed.",
          },
        ],
      })
      expect(boundary.readAssistant).not.toHaveBeenCalled()
      expect(JSON.stringify(result)).not.toContain(
        "synthetic-value-must-not-leak"
      )
    }
  )

  it("rejects an oversized UTF-8 body before fetching the saved configuration", async () => {
    const result = await validateAssistantDraft({
      ...fixture().request,
      source: "preview",
      preview: { instructions: "é".repeat(128 * 1024) },
    })
    expect(result).toEqual({
      issues: [
        { field: "draft", message: "The draft must fit within 256 KiB." },
      ],
      tools: [],
    })
    expect(boundary.readAssistant).not.toHaveBeenCalled()
  })

  it("compiles a preview without writes, mutation, connection access or secret exposure", async () => {
    const { assistant, request } = fixture()
    const saved = { ...assistant, instructions: "" }
    // A safe read should omit these fields. Trap accidental downstream access too.
    const connectionAccess = vi.fn(() => {
      throw new Error("Synthetic connection data must not be read")
    })
    for (const key of ["serverUrl", "serverSecret", "serverSecretCiphertext"])
      Object.defineProperty(saved, key, {
        get: connectionAccess,
        enumerable: false,
      })
    boundary.readAssistant.mockResolvedValue(saved)
    const preview = { instructions: "Synthetic preview instructions" }
    const before = structuredClone(request)
    const result = await validateAssistantDraft({
      ...request,
      source: "preview",
      preview,
    })
    expect(result.issues).toEqual([])
    expect(Object.keys(result).sort()).toEqual(["issues", "tools"])
    expect(saved.instructions).toBe("")
    expect(request).toEqual(before)
    expect(preview).toEqual({ instructions: "Synthetic preview instructions" })
    expect(connectionAccess).not.toHaveBeenCalled()
    expect(boundary.getDb).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toMatch(
      /serverUrl|serverSecret|Ciphertext|Synthetic preview/
    )
    // The preview actually changes compiler input: the invalid saved source still fails.
    const savedResult = await validateAssistantDraft(request)
    expect(savedResult.issues).toContainEqual(
      expect.objectContaining({ field: "instructions" })
    )
  })

  it("reports the current revision instead of treating a stale preview as validated", async () => {
    const { assistant, request } = fixture()
    boundary.readAssistant.mockResolvedValue({ ...assistant, revision: 4 })
    const result = await validateAssistantDraft({
      ...request,
      source: "preview",
      preview: { instructions: "Local changes" },
    })
    expect(result.currentRevision).toBe(4)
    expect(result.issues).toEqual([
      expect.objectContaining({
        field: "revision",
        message: expect.stringContaining("explicitly rebase"),
      }),
    ])
  })

  it.each([
    { preview: { voice: "not-a-supported-voice" }, field: "voice" },
    {
      preview: { backendModel: "not-a-supported-model" },
      field: "backendModel",
    },
    { preview: { instructions: "" }, field: "instructions" },
    { preview: { tools: "[unfinished" }, field: "tools" },
  ])(
    "runs the actual compiler for invalid $field previews",
    async ({ preview, field }) => {
      const result = await validateAssistantDraft({
        ...fixture().request,
        source: "preview",
        preview,
      })
      expect(result.issues).toContainEqual(expect.objectContaining({ field }))
    }
  )

  it("requires coverage for every tool and an explicit default, while accepting null", async () => {
    const { request } = fixture()
    const missing = await validateAssistantDraft({ ...request, samples: [] })
    expect(missing.issues).toContainEqual(
      expect.objectContaining({
        field: "definitions",
        message: expect.stringContaining("explicit default sample result"),
      })
    )
    const { defaultResult: omitted, ...withoutDefault } = request.samples[0]!
    expect(omitted).toBeDefined()
    const noDefault = await validateAssistantDraft({
      ...request,
      samples: [withoutDefault],
    })
    expect(noDefault.issues).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("explicit JSON default result"),
      })
    )
    const explicitNull = await validateAssistantDraft({
      ...request,
      samples: [{ ...request.samples[0]!, defaultResult: null }],
    })
    expect(explicitNull.issues).toEqual([])
  })

  it("requires both sample fingerprints to acknowledge the current preview tool schema", async () => {
    const { assistant, request } = fixture()
    const tools = structuredClone(assistant.tools)
    tools[0]!.parameters.properties.question.type = "number"
    const preview = { tools }
    const fingerprint = fingerprintToolInputSchema(tools[0]!)
    const oldSample = request.samples[0]!
    for (const sample of [
      oldSample,
      { ...oldSample, inputSchemaFingerprint: fingerprint },
      { ...oldSample, reviewedFingerprint: fingerprint },
    ]) {
      const result = await validateAssistantDraft({
        ...request,
        source: "preview",
        preview,
        samples: [sample],
      })
      expect(result.tools[0]!.fingerprint).toBe(fingerprint)
      expect(result.issues).toContainEqual(
        expect.objectContaining({
          message: expect.stringContaining("review its samples again"),
        })
      )
    }
    const reviewed = await validateAssistantDraft({
      ...request,
      source: "preview",
      preview,
      samples: [
        {
          ...oldSample,
          inputSchemaFingerprint: fingerprint,
          reviewedFingerprint: fingerprint,
        },
      ],
    })
    expect(reviewed.issues).toEqual([])
  })

  it.each([
    [{ name: "", result: null }],
    [{ name: "x".repeat(65), result: null }],
    [{ name: "contains spaces", result: null }],
    [
      { name: "duplicate", result: null },
      { name: "duplicate", result: false },
    ],
    [{ name: "missing_result" }],
    [{ name: "extra_field", result: null, unsupported: true }],
    [{ name: "too_large", result: "é".repeat(8192) }],
  ])("rejects invalid named override pack %#", async (...overrides) => {
    const { request } = fixture()
    const result = await validateAssistantDraft({
      ...request,
      samples: [{ ...request.samples[0]!, overrides }],
    })
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        field: "definitions",
        message: expect.stringContaining("invalid or duplicate override"),
      })
    )
  })

  it("accepts override name/result bounds exactly and rejects an oversized default or total pack", async () => {
    const { request } = fixture()
    const sample = request.samples[0]!
    const exactResult = "é".repeat(8191)
    expect(Buffer.byteLength(JSON.stringify(exactResult))).toBe(16 * 1024)
    const exact = await validateAssistantDraft({
      ...request,
      samples: [
        {
          ...sample,
          defaultResult: exactResult,
          overrides: [{ name: "x".repeat(64), result: exactResult }],
        },
      ],
    })
    expect(exact.issues).toEqual([])
    const tooLarge = await validateAssistantDraft({
      ...request,
      samples: [{ ...sample, defaultResult: exactResult + "x" }],
    })
    expect(tooLarge.issues).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("default result exceeds"),
      })
    )
    const pack = await validateAssistantDraft({
      ...request,
      samples: [
        {
          ...sample,
          overrides: Array.from({ length: 5 }, (_, index) => ({
            name: `sample_${index}`,
            result: exactResult,
          })),
        },
      ],
    })
    expect(pack.issues).toContainEqual(
      expect.objectContaining({
        message: "Samples must fit within 65536 bytes.",
      })
    )
  })
})
