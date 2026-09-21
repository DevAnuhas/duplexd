import { createHash } from "node:crypto"

import Ajv from "ajv"

import { validateTools, type ValidationIssue } from "@/lib/validate"

export const PRACTICE_COMPILER_VERSION = "practice-v1" as const
export const PRACTICE_DISCLOSURE_VERSION = "practice-disclosure-v1" as const
export const MAX_PRACTICE_TOOLS = 32

export const SUPPORTED_PRACTICE_CAPABILITIES = {
  voices: [
    "alloy",
    "ash",
    "ballad",
    "coral",
    "echo",
    "fable",
    "marin",
    "nova",
    "onyx",
    "sage",
    "shimmer",
    "verse",
  ],
  backendModels: ["gpt-5.6-luna"],
} as const

export type JsonPrimitive = string | number | boolean | null
export type JsonValue =
  JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export type AssistantTool = {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export type PracticeSampleOverride = {
  name: string
  result: JsonValue
}

export type PracticeSampleDefinition = {
  toolName: string
  inputSchemaFingerprint: string
  reviewedFingerprint: string
  defaultResult: JsonValue
  overrides: PracticeSampleOverride[]
}

export type PracticeScenario = {
  transport: "success" | "slow" | "failure"
  overrides: Record<string, string>
}

export type RunnableAssistant = {
  id: string
  revision: number
  voice: string | null
  accentStyle: string | null
  instructions: string | null
  backendInstructions: string | null
  backendModel: string | null
  waitingBehavior: string | null
  tools: unknown
  serverUrl?: string | null
  hasServerSecret?: boolean
}

export type PracticePreview = Partial<
  Pick<
    RunnableAssistant,
    | "voice"
    | "accentStyle"
    | "instructions"
    | "backendInstructions"
    | "backendModel"
    | "waitingBehavior"
    | "tools"
  >
>

export type FrozenPracticeSnapshot = {
  assistantId: string
  baseAssistantRevision: number
  configSource: "saved" | "preview"
  compilerVersion: typeof PRACTICE_COMPILER_VERSION
  disclosureVersion: typeof PRACTICE_DISCLOSURE_VERSION
  voice: string
  accentStyle: string
  instructions: string
  backendInstructions: string
  backendModel: string
  waitingBehavior: string
  tools: AssistantTool[]
  samples: PracticeSampleDefinition[]
  sampleRevision: number
  scenario: PracticeScenario
  scenarioRevision: number
  configDigest: string
}

const PREVIEW_FIELDS = new Set([
  "voice",
  "accentStyle",
  "instructions",
  "backendInstructions",
  "backendModel",
  "waitingBehavior",
  "tools",
])

const PRACTICE_DISCLOSURE =
  "Practice mode is active. All tool results are synthetic sample data. " +
  "Say that clearly before relying on a result, and never describe a sample " +
  "as a live customer record or completed real-world action."

function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalise)
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalise(child)])
    )
  }

  return value
}

export function canonicalJson(value: unknown): string {
  const encoded = JSON.stringify(canonicalise(value))

  if (encoded === undefined) {
    throw new Error("Value is not JSON serializable.")
  }

  return encoded
}

export function sha256Digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex")
}

export function fingerprintToolInputSchema(
  tool: Pick<AssistantTool, "name" | "parameters">
): string {
  return sha256Digest({ name: tool.name, parameters: tool.parameters })
}

export function projectAssistantTools(value: unknown): AssistantTool[] | null {
  if (!Array.isArray(value)) return null

  const projected: AssistantTool[] = []
  for (const candidate of value) {
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      return null
    }

    const { name, description, parameters } = candidate as Record<
      string,
      unknown
    >
    if (
      typeof name !== "string" ||
      typeof description !== "string" ||
      parameters === null ||
      typeof parameters !== "object" ||
      Array.isArray(parameters)
    ) {
      return null
    }
    projected.push({
      name,
      description,
      parameters: structuredClone(parameters as Record<string, unknown>),
    })
  }

  return projected
}

function missingText(
  assistant: RunnableAssistant,
  field: keyof Pick<
    RunnableAssistant,
    "voice" | "instructions" | "backendModel" | "backendInstructions"
  >
): ValidationIssue | null {
  const value = assistant[field]
  return typeof value !== "string" || value.trim() === ""
    ? { field, message: `${field} is required before this assistant can run.` }
    : null
}

/** One mode-aware runnable predicate. Editable drafts remain saveable. */
export function validateRunnableAssistant(
  assistant: RunnableAssistant,
  mode: "integration" | "practice"
): ValidationIssue[] {
  const issues = [
    missingText(assistant, "voice"),
    missingText(assistant, "instructions"),
    missingText(assistant, "backendModel"),
    missingText(assistant, "backendInstructions"),
  ].filter((issue): issue is ValidationIssue => issue !== null)

  if (typeof assistant.accentStyle !== "string") {
    issues.push({
      field: "accentStyle",
      message: "accentStyle is required before this assistant can run.",
    })
  }
  if (typeof assistant.waitingBehavior !== "string") {
    issues.push({
      field: "waitingBehavior",
      message: "waitingBehavior is required before this assistant can run.",
    })
  }

  issues.push(...validateTools(assistant.tools))
  const tools = projectAssistantTools(assistant.tools)
  if (tools === null) {
    issues.push({ field: "tools", message: "Tools cannot be compiled." })
  } else if (tools.length > MAX_PRACTICE_TOOLS) {
    issues.push({
      field: "tools",
      message: `An assistant can define at most ${MAX_PRACTICE_TOOLS} tools.`,
    })
  }

  if (mode === "integration") {
    if (
      typeof assistant.serverUrl !== "string" ||
      assistant.serverUrl.trim() === ""
    ) {
      issues.push({
        field: "serverUrl",
        message: "serverUrl is required before this assistant can run.",
      })
    }
    if (assistant.hasServerSecret !== true) {
      issues.push({
        field: "serverSecret",
        message: "serverSecret is required before this assistant can run.",
      })
    }
  } else {
    if (
      typeof assistant.voice === "string" &&
      !(SUPPORTED_PRACTICE_CAPABILITIES.voices as readonly string[]).includes(
        assistant.voice
      )
    ) {
      issues.push({
        field: "voice",
        message: `Voice "${assistant.voice}" is not enabled by the deployed Practice runtime.`,
      })
    }
    if (
      typeof assistant.backendModel === "string" &&
      !(
        SUPPORTED_PRACTICE_CAPABILITIES.backendModels as readonly string[]
      ).includes(assistant.backendModel)
    ) {
      issues.push({
        field: "backendModel",
        message: `Backend model "${assistant.backendModel}" is not enabled by the deployed Practice runtime.`,
      })
    }
  }

  return issues.filter(
    (issue, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.field === issue.field && candidate.message === issue.message
      ) === index
  )
}

function samplesForTools(
  tools: AssistantTool[],
  definitions: PracticeSampleDefinition[]
): { definitions: PracticeSampleDefinition[]; issues: ValidationIssue[] } {
  const byName = new Map(
    definitions.map((definition) => [definition.toolName, definition])
  )
  const issues: ValidationIssue[] = []
  const selected: PracticeSampleDefinition[] = []

  for (const tool of tools) {
    const definition = byName.get(tool.name)
    const fingerprint = fingerprintToolInputSchema(tool)
    if (definition === undefined) {
      issues.push({
        field: "samples",
        message: `Tool "${tool.name}" needs an explicit default sample result.`,
      })
      continue
    }
    if (
      definition.inputSchemaFingerprint !== fingerprint ||
      definition.reviewedFingerprint !== fingerprint
    ) {
      issues.push({
        field: "samples",
        message: `Tool "${tool.name}" changed its name or input schema; review its samples again.`,
      })
      continue
    }
    selected.push(structuredClone(definition))
  }

  for (const definition of definitions) {
    if (!tools.some((tool) => tool.name === definition.toolName)) {
      issues.push({
        field: "samples",
        message: `Sample tool "${definition.toolName}" is not present in this configuration.`,
      })
    }
  }

  return { definitions: selected, issues }
}

export type CompilePracticeInput = {
  assistant: RunnableAssistant
  baseRevision: number
  source: "saved" | "preview"
  preview?: Record<string, unknown>
  samples: PracticeSampleDefinition[]
  sampleRevision: number
  scenario?: Partial<PracticeScenario>
  scenarioRevision?: number
}

export type CompilePracticeResult =
  | { kind: "assistant_changed"; currentRevision: number }
  | { kind: "invalid"; issues: ValidationIssue[] }
  | { kind: "ready"; snapshot: FrozenPracticeSnapshot }

/** Pure compiler: no database access, customer URL lookup, or secret lookup. */
export function compilePracticeConfiguration(
  input: CompilePracticeInput
): CompilePracticeResult {
  if (input.assistant.revision !== input.baseRevision) {
    return {
      kind: "assistant_changed",
      currentRevision: input.assistant.revision,
    }
  }

  const preview = input.preview ?? {}
  const invalidPreviewFields = Object.keys(preview).filter(
    (field) => !PREVIEW_FIELDS.has(field)
  )
  if (invalidPreviewFields.length > 0) {
    return {
      kind: "invalid",
      issues: invalidPreviewFields.map((field) => ({
        field,
        message: `Preview field "${field}" is not allowed.`,
      })),
    }
  }

  const merged: RunnableAssistant =
    input.source === "preview"
      ? { ...input.assistant, ...(preview as PracticePreview) }
      : { ...input.assistant }
  const runnableIssues = validateRunnableAssistant(merged, "practice")
  const tools = projectAssistantTools(merged.tools)
  if (runnableIssues.length > 0 || tools === null) {
    return { kind: "invalid", issues: runnableIssues }
  }

  const coverage = samplesForTools(tools, input.samples)
  if (coverage.issues.length > 0) {
    return { kind: "invalid", issues: coverage.issues }
  }

  const scenario: PracticeScenario = {
    transport: input.scenario?.transport ?? "success",
    overrides: { ...(input.scenario?.overrides ?? {}) },
  }
  for (const [toolName, overrideName] of Object.entries(scenario.overrides)) {
    const sample = coverage.definitions.find(
      (definition) => definition.toolName === toolName
    )
    if (sample === undefined) {
      return {
        kind: "invalid",
        issues: [
          {
            field: "scenario",
            message: `Scenario references unknown tool "${toolName}".`,
          },
        ],
      }
    }
    if (!sample.overrides.some((override) => override.name === overrideName)) {
      delete scenario.overrides[toolName]
    }
  }

  const authored = {
    assistantId: merged.id,
    baseAssistantRevision: input.baseRevision,
    configSource: input.source,
    compilerVersion: PRACTICE_COMPILER_VERSION,
    disclosureVersion: PRACTICE_DISCLOSURE_VERSION,
    voice: merged.voice!,
    accentStyle: merged.accentStyle!,
    instructions: `${merged.instructions!}\n\n${PRACTICE_DISCLOSURE}`,
    backendInstructions: merged.backendInstructions!,
    backendModel: merged.backendModel!,
    waitingBehavior: merged.waitingBehavior!,
    tools,
    samples: coverage.definitions,
    sampleRevision: input.sampleRevision,
    scenario,
    scenarioRevision: input.scenarioRevision ?? 1,
  } as const

  return {
    kind: "ready",
    snapshot: {
      ...authored,
      configDigest: sha256Digest(authored),
    },
  }
}

const argumentValidators = new Map<string, ReturnType<Ajv["compile"]>>()

export function validatePracticeArguments(
  tool: AssistantTool,
  value: unknown
): boolean {
  const fingerprint = fingerprintToolInputSchema(tool)
  let validator = argumentValidators.get(fingerprint)
  if (validator === undefined) {
    validator = new Ajv({ strict: false, allErrors: true }).compile(
      tool.parameters
    )
    argumentValidators.set(fingerprint, validator)
  }
  return Boolean(validator(value))
}
