"use server"

import { requireCurrentAccount } from "@/lib/account"
import { getAssistantPracticeSourceForAccount } from "@/data/assistants"
import {
  compilePracticeConfiguration,
  fingerprintToolInputSchema,
  projectAssistantTools,
} from "@/practice/configuration"
import { parsePracticeSampleDefinitions } from "@/practice/samples"
import { validateTools } from "@/lib/validate"
import type { DraftValidation } from "@/sandbox/client/draft-store"

/** Authenticated read-only preflight. It cannot save, prepare, mint credentials or start a provider. */
export async function validateAssistantDraft(input: {
  assistantId: string
  baseRevision: number
  source: "saved" | "preview"
  preview?: Record<string, unknown>
  samples: unknown
}): Promise<DraftValidation & { currentRevision?: number }> {
  const { accountId } = await requireCurrentAccount()
  const invalid = (message: string): DraftValidation => ({
    issues: [{ field: "draft", message }],
    tools: [],
  })
  if (
    input === null ||
    typeof input !== "object" ||
    Buffer.byteLength(JSON.stringify(input), "utf8") > 256 * 1024
  )
    return invalid("The draft must fit within 256 KiB.")
  if (
    Object.keys(input).some(
      (key) =>
        ![
          "assistantId",
          "baseRevision",
          "source",
          "preview",
          "samples",
        ].includes(key)
    ) ||
    typeof input.assistantId !== "string" ||
    !Number.isSafeInteger(input.baseRevision) ||
    input.baseRevision < 1 ||
    !["saved", "preview"].includes(input.source)
  )
    return invalid("The draft request is invalid.")
  if (
    input.preview !== undefined &&
    (input.preview === null ||
      typeof input.preview !== "object" ||
      Array.isArray(input.preview) ||
      Object.keys(input.preview).some(
        (key) =>
          ![
            "voice",
            "accentStyle",
            "instructions",
            "backendInstructions",
            "backendModel",
            "waitingBehavior",
            "tools",
          ].includes(key)
      ))
  )
    return invalid(
      "Only conversation, voice, backend model and tool fields may be previewed."
    )
  const assistant = await getAssistantPracticeSourceForAccount(
    accountId,
    input.assistantId
  )
  if (assistant === null)
    return invalid("This assistant is no longer available.")
  const toolValues =
    input.source === "preview" && input.preview?.tools !== undefined
      ? input.preview.tools
      : assistant.tools
  const projected =
    validateTools(toolValues).length === 0
      ? projectAssistantTools(toolValues)
      : null
  const tools = (projected ?? []).map((tool) => ({
    name: tool.name,
    fingerprint: fingerprintToolInputSchema(tool),
    parameters: tool.parameters,
  }))
  const parsed = parsePracticeSampleDefinitions(input.samples, toolValues)
  const result = compilePracticeConfiguration({
    assistant,
    baseRevision: input.baseRevision,
    source: input.source,
    preview: input.preview,
    samples: parsed.ok ? parsed.definitions : [],
    sampleRevision: 0,
  })
  const issues = [
    ...(parsed.ok ? [] : parsed.issues),
    ...(result.kind === "invalid"
      ? result.issues
      : result.kind === "assistant_changed"
        ? [
            {
              field: "revision",
              message:
                "The saved assistant changed. Fetch the latest version, then reload or explicitly rebase your draft.",
            },
          ]
        : []),
  ]
  return {
    tools,
    issues: issues.filter(
      (issue, index) =>
        issues.findIndex(
          (candidate) =>
            candidate.field === issue.field &&
            candidate.message === issue.message
        ) === index
    ),
    ...(result.kind === "assistant_changed"
      ? { currentRevision: result.currentRevision }
      : {}),
  }
}
