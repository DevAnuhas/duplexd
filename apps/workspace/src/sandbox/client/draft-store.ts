import type { AssistantFormInput } from "@/lib/assistant-schema"
import type { PracticeSampleDefinition } from "@/practice/configuration"

export const PREVIEW_FIELDS = [
  "voice",
  "accentStyle",
  "instructions",
  "backendInstructions",
  "backendModel",
  "waitingBehavior",
  "tools",
] as const
export type DraftFields = Pick<
  AssistantFormInput,
  (typeof PREVIEW_FIELDS)[number]
>
export type DraftIssue = { field: string; message: string }
export type ToolFingerprint = {
  name: string
  fingerprint: string
  parameters: Record<string, unknown>
}
export type DraftValidation = { issues: DraftIssue[]; tools: ToolFingerprint[] }
export type SampleDraft = {
  toolName: string
  inputSchemaFingerprint: string
  reviewedFingerprint: string
  defaultText: string
  overridesText: string
}
export type DraftSeed = {
  assistantId: string
  revision: number
  fields: DraftFields
  sampleRevision: number
  definitions: PracticeSampleDefinition[]
  suggestedDefinitions?: PracticeSampleDefinition[]
}
export type DraftSnapshot = {
  assistantId: string
  baseRevision: number
  saved: DraftFields
  fields: DraftFields
  sampleRevision: number
  savedSamples: SampleDraft[]
  samples: SampleDraft[]
  source: "saved" | "preview"
  latest: DraftSeed | null
  assistantConflict: number | null
  sampleConflict: number | null
  version: number
  formEpoch: number
  saving: boolean
  editorOnlyDirty: boolean
  validation: DraftValidation | null
}

/** Pick every field explicitly: names, connection URLs and secrets never enter this store. */
export function previewFields(value: Partial<AssistantFormInput>): DraftFields {
  return Object.fromEntries(
    PREVIEW_FIELDS.map((key) => [
      key,
      typeof value[key] === "string" ? value[key] : key === "tools" ? "[]" : "",
    ])
  ) as DraftFields
}
export function sampleDrafts(
  definitions: PracticeSampleDefinition[]
): SampleDraft[] {
  return definitions.map((definition) => ({
    toolName: definition.toolName,
    inputSchemaFingerprint: definition.inputSchemaFingerprint,
    reviewedFingerprint: definition.reviewedFingerprint,
    defaultText: JSON.stringify(definition.defaultResult, null, 2),
    overridesText: JSON.stringify(definition.overrides, null, 2),
  }))
}
export function fieldsDirty(state: DraftSnapshot) {
  return PREVIEW_FIELDS.some((key) => state.fields[key] !== state.saved[key])
}
export function samplesDirty(state: DraftSnapshot) {
  return JSON.stringify(state.samples) !== JSON.stringify(state.savedSamples)
}
export function draftDirty(state: DraftSnapshot) {
  return fieldsDirty(state) || samplesDirty(state) || state.editorOnlyDirty
}

/** Browser parsing is syntax/byte-bound only. Authoritative validation remains on the server. */
export function readSampleDrafts(rows: SampleDraft[]): {
  definitions: unknown[]
  issues: DraftIssue[]
} {
  const issues: DraftIssue[] = []
  const definitions: unknown[] = []
  for (const row of rows) {
    if (
      new TextEncoder().encode(row.defaultText).byteLength > 16 * 1024 ||
      new TextEncoder().encode(row.overridesText).byteLength > 64 * 1024
    ) {
      issues.push({
        field: "samples",
        message: `Sample ${row.toolName} is too large. Default results must fit within 16 KiB and the entire sample pack within 64 KiB.`,
      })
      continue
    }
    try {
      definitions.push({
        toolName: row.toolName,
        inputSchemaFingerprint: row.inputSchemaFingerprint,
        reviewedFingerprint: row.reviewedFingerprint,
        defaultResult: JSON.parse(row.defaultText),
        overrides: JSON.parse(row.overridesText),
      })
    } catch {
      issues.push({
        field: "samples",
        message: `Sample ${row.toolName} needs valid JSON for its default result and named overrides.`,
      })
    }
  }
  if (
    new TextEncoder().encode(JSON.stringify(definitions)).byteLength >
    64 * 1024
  )
    issues.push({
      field: "samples",
      message: "The complete sample pack must fit within 64 KiB.",
    })
  return { definitions, issues }
}
export function readPreview(fields: DraftFields): {
  preview: Record<string, unknown>
  issues: DraftIssue[]
} {
  try {
    return {
      preview: { ...previewFields(fields), tools: JSON.parse(fields.tools) },
      issues: [],
    }
  } catch {
    return {
      preview: {},
      issues: [
        {
          field: "tools",
          message: "Tools must be valid JSON. Your draft has been kept.",
        },
      ],
    }
  }
}

export class AssistantDraftStore {
  private state: DraftSnapshot
  private listeners = new Set<() => void>()
  constructor(seed: DraftSeed) {
    const saved = previewFields(seed.fields)
    this.state = {
      assistantId: seed.assistantId,
      baseRevision: seed.revision,
      saved,
      fields: { ...saved },
      sampleRevision: seed.sampleRevision,
      savedSamples: sampleDrafts(seed.definitions),
      samples: sampleDrafts(seed.suggestedDefinitions ?? seed.definitions),
      source: "saved",
      latest: null,
      assistantConflict: null,
      sampleConflict: null,
      version: 0,
      formEpoch: 0,
      saving: false,
      editorOnlyDirty: false,
      validation: null,
    }
  }
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private update(patch: Partial<DraftSnapshot>, invalidate = true) {
    this.state = {
      ...this.state,
      ...patch,
      ...(invalidate
        ? { version: this.state.version + 1, validation: null }
        : {}),
    }
    this.listeners.forEach((listener) => listener())
  }
  edit(fields: Partial<AssistantFormInput>) {
    const next = previewFields(fields)
    if (JSON.stringify(next) !== JSON.stringify(this.state.fields))
      this.update({ fields: next, source: "preview" })
  }
  setSaving(saving: boolean) {
    this.update({ saving }, false)
  }
  setEditorOnlyDirty(dirty: boolean) {
    if (dirty !== this.state.editorOnlyDirty)
      this.update({ editorOnlyDirty: dirty }, false)
  }
  setSource(source: "saved" | "preview") {
    if (source !== this.state.source) this.update({ source })
  }
  editSamples(samples: SampleDraft[]) {
    this.update({ samples: structuredClone(samples) })
  }
  setValidation(version: number, validation: DraftValidation) {
    if (version === this.state.version) this.update({ validation }, false)
  }
  conflict(kind: "assistant" | "samples", revision: number) {
    const current =
      kind === "assistant"
        ? this.state.assistantConflict
        : this.state.sampleConflict
    if (current !== null && current >= revision) return
    this.update(
      kind === "assistant"
        ? { assistantConflict: revision }
        : { sampleConflict: revision },
      false
    )
  }
  observe(seed: DraftSeed) {
    if (seed.assistantId !== this.state.assistantId) return
    const assistantChanged = seed.revision > this.state.baseRevision
    const samplesChanged = seed.sampleRevision > this.state.sampleRevision
    if (
      seed.revision < this.state.baseRevision ||
      seed.sampleRevision < this.state.sampleRevision
    )
      return
    if (
      !assistantChanged &&
      !samplesChanged &&
      this.state.assistantConflict === null &&
      this.state.sampleConflict === null
    )
      return
    const previous = this.state.latest
    const assistantSeed =
      previous !== null && previous.revision > seed.revision ? previous : seed
    const sampleSeed =
      previous !== null && previous.sampleRevision > seed.sampleRevision
        ? previous
        : seed
    this.update(
      {
        latest: {
          assistantId: seed.assistantId,
          revision: assistantSeed.revision,
          sampleRevision: sampleSeed.sampleRevision,
          definitions: structuredClone(sampleSeed.definitions),
          fields: previewFields(assistantSeed.fields),
        },
        ...(assistantChanged
          ? {
              assistantConflict: Math.max(
                seed.revision,
                this.state.assistantConflict ?? 0
              ),
            }
          : {}),
        ...(samplesChanged
          ? {
              sampleConflict: Math.max(
                seed.sampleRevision,
                this.state.sampleConflict ?? 0
              ),
            }
          : {}),
      },
      false
    )
  }
  canResolveConflict() {
    const { latest, assistantConflict, sampleConflict } = this.state
    return (
      (assistantConflict === null && sampleConflict === null) ||
      (latest !== null &&
        latest.revision >= (assistantConflict ?? this.state.baseRevision) &&
        latest.sampleRevision >= (sampleConflict ?? this.state.sampleRevision))
    )
  }
  /** Explicit acknowledgement overlays only locally edited fields on the latest saved revision. */
  rebase() {
    const latest = this.state.latest
    if (latest === null || !this.canResolveConflict()) return
    const dirtyKeys = PREVIEW_FIELDS.filter(
      (key) => this.state.fields[key] !== this.state.saved[key]
    )
    const fields = previewFields(latest.fields)
    for (const key of dirtyKeys) fields[key] = this.state.fields[key]
    const samples = samplesDirty(this.state)
      ? this.state.samples
      : sampleDrafts(latest.definitions)
    this.update({
      saved: previewFields(latest.fields),
      fields,
      baseRevision: latest.revision,
      sampleRevision: latest.sampleRevision,
      savedSamples: sampleDrafts(latest.definitions),
      samples,
      latest: null,
      assistantConflict: null,
      sampleConflict: null,
      formEpoch: this.state.formEpoch + 1,
    })
  }
  discard() {
    if (!this.canResolveConflict()) return
    const latest = this.state.latest
    this.update({
      saved: latest === null ? this.state.saved : previewFields(latest.fields),
      fields:
        latest === null
          ? { ...this.state.saved }
          : previewFields(latest.fields),
      baseRevision: latest?.revision ?? this.state.baseRevision,
      sampleRevision: latest?.sampleRevision ?? this.state.sampleRevision,
      savedSamples:
        latest === null
          ? this.state.savedSamples
          : sampleDrafts(latest.definitions),
      samples:
        latest === null
          ? structuredClone(this.state.savedSamples)
          : sampleDrafts(latest.definitions),
      latest: null,
      assistantConflict: null,
      sampleConflict: null,
      editorOnlyDirty: false,
      source: "saved",
      formEpoch: this.state.formEpoch + 1,
    })
  }
  savedAssistant(fields: DraftFields, revision: number) {
    const safe = previewFields(fields)
    this.update({
      saved: safe,
      fields: safe,
      baseRevision: revision,
      assistantConflict: null,
      editorOnlyDirty: false,
      source: "saved",
      latest:
        this.state.latest !== null &&
        (this.state.latest.revision > revision ||
          this.state.latest.sampleRevision > this.state.sampleRevision)
          ? this.state.latest
          : null,
    })
  }
  savedSampleDefinitions(
    definitions: PracticeSampleDefinition[],
    revision: number
  ) {
    const samples = sampleDrafts(definitions)
    this.update({
      savedSamples: samples,
      samples: structuredClone(samples),
      sampleRevision: revision,
      sampleConflict: null,
    })
  }
}
