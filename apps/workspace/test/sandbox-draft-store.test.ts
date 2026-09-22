import { describe, expect, it, vi } from "vitest"

import { rileyPracticeTemplate } from "@/practice/riley"
import {
  AssistantDraftStore,
  draftDirty,
  previewFields,
  readPreview,
  readSampleDrafts,
  sampleDrafts,
  type DraftSeed,
} from "@/sandbox/client/draft-store"

function seed(): DraftSeed {
  const template = rileyPracticeTemplate()
  return {
    assistantId: "synthetic-assistant",
    revision: 3,
    fields: previewFields({
      ...template.assistant,
      serverUrl: "",
      tools: JSON.stringify(template.assistant.tools),
    }),
    sampleRevision: 2,
    definitions: template.samples,
  }
}

const allowedFields = [
  "accentStyle",
  "backendInstructions",
  "backendModel",
  "instructions",
  "tools",
  "voice",
  "waitingBehavior",
]
const forbidden = {
  name: "synthetic-name-must-not-cross",
  serverUrl: "https://synthetic.invalid/must-not-cross",
  serverSecret: "synthetic-secret-must-not-cross",
  accountId: "synthetic-account-must-not-cross",
  unknown: "synthetic-unknown-must-not-cross",
}

describe("Sandbox draft store boundaries", () => {
  it("allowlists fields at construction, editing, observation, rebase, discard and save", () => {
    const initial = seed()
    const unsafeFields = { ...initial.fields, ...forbidden }
    const store = new AssistantDraftStore({ ...initial, fields: unsafeFields })
    const assertSafe = () => {
      const state = store.getSnapshot()
      for (const fields of [state.fields, state.saved, state.latest?.fields]) {
        if (fields !== undefined)
          expect(Object.keys(fields).sort()).toEqual(allowedFields)
      }
      for (const value of Object.values(forbidden))
        expect(JSON.stringify(state)).not.toContain(value)
      expect(Object.keys(readPreview(state.fields).preview).sort()).toEqual(
        allowedFields
      )
    }
    assertSafe()
    store.edit({ ...unsafeFields, instructions: "Local instructions" })
    assertSafe()
    store.observe({ ...initial, revision: 4, fields: unsafeFields })
    assertSafe()
    store.rebase()
    assertSafe()
    store.observe({ ...initial, revision: 5, fields: unsafeFields })
    store.discard()
    assertSafe()
    store.savedAssistant(unsafeFields, 6)
    assertSafe()
  })

  it("preserves malformed tools and sample JSON exactly across validation and rebase", () => {
    const initial = seed()
    const store = new AssistantDraftStore(initial)
    const tools = ' [ {\n  "unfinished": '
    const rows = sampleDrafts(initial.definitions)
    rows[0]!.defaultText = '{\n  "unfinished": '
    rows[0]!.overridesText = "[oops"
    store.edit({ ...initial.fields, tools })
    store.editSamples(rows)
    expect(readPreview(store.getSnapshot().fields).issues).toEqual([
      expect.objectContaining({ field: "tools" }),
    ])
    expect(readSampleDrafts(store.getSnapshot().samples).issues).toHaveLength(1)
    store.setValidation(store.getSnapshot().version, {
      issues: [{ field: "tools", message: "Invalid JSON" }],
      tools: [],
    })
    store.observe({ ...initial, revision: 4, sampleRevision: 3 })
    store.rebase()
    expect(store.getSnapshot().fields.tools).toBe(tools)
    expect(store.getSnapshot().samples).toEqual(rows)
    expect(store.getSnapshot().validation).toBeNull()
  })

  it("ignores out-of-order validation and invalidates results when samples or source change", () => {
    const store = new AssistantDraftStore(seed())
    const firstVersion = store.getSnapshot().version
    const oldResult = {
      issues: [{ field: "tools", message: "Old" }],
      tools: [],
    }
    store.edit({ ...store.getSnapshot().fields, instructions: "Changed" })
    const listener = vi.fn()
    store.subscribe(listener)
    store.setValidation(firstVersion, oldResult)
    expect(store.getSnapshot().validation).toBeNull()
    expect(listener).not.toHaveBeenCalled()
    const current = { issues: [], tools: [] }
    store.setValidation(store.getSnapshot().version, current)
    expect(store.getSnapshot().validation).toBe(current)
    const validatedVersion = store.getSnapshot().version
    store.editSamples([])
    expect(store.getSnapshot().validation).toBeNull()
    store.setValidation(validatedVersion, current)
    expect(store.getSnapshot().validation).toBeNull()
    store.setValidation(store.getSnapshot().version, current)
    store.setSource("saved")
    expect(store.getSnapshot().validation).toBeNull()
  })

  it("requires explicit rebase even when no local fields are dirty", () => {
    const initial = seed()
    const store = new AssistantDraftStore(initial)
    const remote = {
      ...initial,
      revision: 4,
      sampleRevision: 3,
      fields: { ...initial.fields, instructions: "Remote instructions" },
    }
    store.observe(remote)
    expect(store.getSnapshot()).toMatchObject({
      baseRevision: 3,
      sampleRevision: 2,
      fields: initial.fields,
      assistantConflict: 4,
      sampleConflict: 3,
    })
    store.rebase()
    expect(store.getSnapshot()).toMatchObject({
      baseRevision: 4,
      sampleRevision: 3,
      fields: remote.fields,
      assistantConflict: null,
      sampleConflict: null,
    })
    expect(draftDirty(store.getSnapshot())).toBe(false)
  })

  it("rebases only changed local fields, keeps authored samples and adopts untouched remote fields", () => {
    const initial = seed()
    const store = new AssistantDraftStore(initial)
    store.edit({ ...initial.fields, instructions: "Local instructions" })
    const localSamples = sampleDrafts(initial.definitions)
    localSamples[0]!.defaultText = '{"synthetic":"local draft"}'
    store.editSamples(localSamples)
    const remote = {
      ...initial,
      revision: 4,
      sampleRevision: 3,
      fields: {
        ...initial.fields,
        instructions: "Remote instructions",
        accentStyle: "Remote style",
      },
      definitions: initial.definitions.map((definition) => ({
        ...definition,
        defaultResult: { synthetic: "remote sample" },
      })),
    }
    store.observe(remote)
    store.rebase()
    expect(store.getSnapshot()).toMatchObject({
      baseRevision: 4,
      sampleRevision: 3,
      fields: {
        instructions: "Local instructions",
        accentStyle: "Remote style",
      },
      saved: remote.fields,
      samples: localSamples,
      savedSamples: sampleDrafts(remote.definitions),
      formEpoch: 1,
      source: "preview",
    })
    expect(draftDirty(store.getSnapshot())).toBe(true)
    store.discard()
    expect(store.getSnapshot().fields).toEqual(remote.fields)
    expect(store.getSnapshot().samples).toEqual(
      sampleDrafts(remote.definitions)
    )
    expect(draftDirty(store.getSnapshot())).toBe(false)
  })

  it("adopts remote samples when the local sample drafts are untouched", () => {
    const initial = seed()
    const store = new AssistantDraftStore(initial)
    const definitions = initial.definitions.map((definition) => ({
      ...definition,
      defaultResult: null,
    }))
    store.observe({ ...initial, sampleRevision: 3, definitions })
    store.rebase()
    expect(store.getSnapshot().samples).toEqual(sampleDrafts(definitions))
    expect(draftDirty(store.getSnapshot())).toBe(false)
  })

  it.each(["assistant", "samples"] as const)(
    "does not resolve a newer %s conflict using an older cached latest seed",
    (kind) => {
      const initial = seed()
      const store = new AssistantDraftStore(initial)
      store.edit({ ...initial.fields, instructions: "Local survives" })
      store.observe({ ...initial, revision: 4, sampleRevision: 3 })
      store.conflict(kind, kind === "assistant" ? 5 : 4)
      const unresolved = store.getSnapshot()
      expect(store.canResolveConflict()).toBe(false)
      store.rebase()
      expect(store.getSnapshot()).toBe(unresolved)
      store.discard()
      expect(store.getSnapshot()).toBe(unresolved)
      store.observe({ ...initial, revision: 5, sampleRevision: 4 })
      expect(store.canResolveConflict()).toBe(true)
      store.rebase()
      expect(store.getSnapshot().fields.instructions).toBe("Local survives")
      expect(store.getSnapshot().baseRevision).toBe(5)
    }
  )

  it.each(["assistant", "samples"] as const)(
    "does not let an out-of-order observation lower a known %s conflict",
    (kind) => {
      const initial = seed()
      const store = new AssistantDraftStore(initial)
      store.conflict(kind, kind === "assistant" ? 5 : 4)
      store.observe({ ...initial, revision: 4, sampleRevision: 3 })
      expect(store.canResolveConflict()).toBe(false)
      store.rebase()
      expect(store.getSnapshot().baseRevision).toBe(3)
      expect(store.getSnapshot().sampleRevision).toBe(2)
    }
  )

  it("ignores foreign seeds and seeds older than either acknowledged revision", () => {
    const initial = seed()
    const store = new AssistantDraftStore(initial)
    const unchanged = store.getSnapshot()
    store.observe({ ...initial, assistantId: "foreign", revision: 10 })
    store.observe({ ...initial, revision: 2, sampleRevision: 10 })
    store.observe({ ...initial, revision: 10, sampleRevision: 1 })
    expect(store.getSnapshot()).toBe(unchanged)
  })

  it.each(["assistant", "samples"] as const)(
    "does not let an older %s conflict callback make a stale seed resolvable",
    (kind) => {
      const initial = seed()
      const store = new AssistantDraftStore(initial)
      store.observe({ ...initial, revision: 4, sampleRevision: 3 })
      store.conflict(kind, kind === "assistant" ? 6 : 5)
      store.conflict(kind, kind === "assistant" ? 4 : 3)
      expect(store.canResolveConflict()).toBe(false)
      const blocked = store.getSnapshot()
      store.rebase()
      store.discard()
      expect(store.getSnapshot()).toBe(blocked)
    }
  )

  it("retains the newest fetched assistant and sample baselines independently", () => {
    const initial = seed()
    const store = new AssistantDraftStore(initial)
    const remoteFields = {
      ...initial.fields,
      instructions: "Newest remote instructions",
    }
    const remoteSamples = initial.definitions.map((definition) => ({
      ...definition,
      defaultResult: { synthetic: "Newest remote sample" },
    }))
    store.observe({ ...initial, revision: 6, fields: remoteFields })
    store.observe({
      ...initial,
      revision: 4,
      sampleRevision: 5,
      definitions: remoteSamples,
    })
    store.observe({ ...initial, revision: 5, sampleRevision: 3 })
    expect(store.getSnapshot()).toMatchObject({
      baseRevision: 3,
      sampleRevision: 2,
      assistantConflict: 6,
      sampleConflict: 5,
      latest: {
        revision: 6,
        sampleRevision: 5,
        fields: remoteFields,
        definitions: remoteSamples,
      },
    })
    store.rebase()
    expect(store.getSnapshot()).toMatchObject({
      baseRevision: 6,
      sampleRevision: 5,
      fields: remoteFields,
      samples: sampleDrafts(remoteSamples),
    })
  })
})

describe("raw sample draft bounds", () => {
  it("accepts an explicit null default and a result exactly at the UTF-8 limit", () => {
    const rows = sampleDrafts(seed().definitions)
    rows[0]!.defaultText = "null"
    expect(readSampleDrafts(rows)).toMatchObject({
      issues: [],
      definitions: [{ defaultResult: null }],
    })
    rows[0]!.defaultText = JSON.stringify("é".repeat(8191))
    expect(Buffer.byteLength(rows[0]!.defaultText)).toBe(16 * 1024)
    expect(readSampleDrafts(rows).issues).toEqual([])
    rows[0]!.defaultText = JSON.stringify("é".repeat(8192))
    expect(readSampleDrafts(rows).issues).toHaveLength(1)
  })

  it("bounds both raw override text and the aggregate serialized sample pack", () => {
    const rows = sampleDrafts(seed().definitions)
    rows[0]!.overridesText = " ".repeat(64 * 1024) + "[]"
    expect(readSampleDrafts(rows).issues).toHaveLength(1)
    const pack = Array.from({ length: 5 }, (_, index) => ({
      ...rows[0]!,
      toolName: `synthetic_${index}`,
      defaultText: JSON.stringify("x".repeat(14 * 1024)),
      overridesText: "[]",
    }))
    expect(readSampleDrafts(pack).issues).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("complete sample pack"),
      }),
    ])
  })
})
