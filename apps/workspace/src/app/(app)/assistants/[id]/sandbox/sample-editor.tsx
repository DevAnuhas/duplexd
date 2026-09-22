"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Textarea } from "@/components/ui/textarea"
import type { PracticeSampleDefinition } from "@/practice/configuration"
import {
  readSampleDrafts,
  samplesDirty,
  type SampleDraft,
} from "@/sandbox/client/draft-store"
import { useAssistantDraft } from "../draft-host"

export function SampleEditor() {
  const { store, state, locked } = useAssistantDraft()
  const router = useRouter()
  const [message, setMessage] = useState<string | null>(null)
  const tools = state.validation?.tools ?? []
  const parsed = readSampleDrafts(state.samples)
  const conflict =
    state.assistantConflict !== null || state.sampleConflict !== null
  const toolsUnsaved =
    state.source === "preview" && state.fields.tools !== state.saved.tools
  const sampleIssues =
    state.validation?.issues.filter(
      (issue) =>
        issue.field.startsWith("samples") || issue.field === "definitions"
    ) ?? []
  const canSave =
    !locked &&
    !conflict &&
    !toolsUnsaved &&
    state.validation !== null &&
    parsed.issues.length === 0 &&
    sampleIssues.length === 0 &&
    samplesDirty(state)
  function edit(index: number, patch: Partial<SampleDraft>) {
    store.editSamples(
      state.samples.map((row, position) =>
        position === index ? { ...row, ...patch } : row
      )
    )
    setMessage(null)
  }
  async function save() {
    if (!canSave) return
    store.setSaving(true)
    setMessage(null)
    try {
      const csrfResponse = await fetch("/api/workspace/sandbox/csrf", {
        credentials: "same-origin",
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      })
      const csrf = await csrfResponse.json()
      if (!csrfResponse.ok || typeof csrf.token !== "string")
        throw new Error("Session unavailable")
      const response = await fetch(
        `/api/workspace/sandbox/assistants/${encodeURIComponent(state.assistantId)}/samples`,
        {
          method: "PUT",
          credentials: "same-origin",
          cache: "no-store",
          signal: AbortSignal.timeout(15_000),
          headers: {
            "content-type": "application/json",
            "x-duplexd-csrf": csrf.token,
          },
          body: JSON.stringify({
            expectedRevision: state.sampleRevision,
            definitions: parsed.definitions,
          }),
        }
      )
      const result = await response.json()
      if (
        response.status === 409 &&
        Number.isSafeInteger(result.currentRevision)
      ) {
        store.conflict("samples", result.currentRevision)
        setMessage(
          "Samples changed elsewhere. Your JSON is kept. Fetch the latest version, then explicitly rebase or discard before saving again."
        )
        router.refresh()
      } else if (!response.ok) {
        setMessage(
          "Samples were not saved. Check the JSON, schema review and coverage, or refresh after signing in. Your draft is kept."
        )
      } else if (
        Number.isSafeInteger(result.revision) &&
        Array.isArray(result.definitions)
      ) {
        store.savedSampleDefinitions(
          result.definitions as PracticeSampleDefinition[],
          result.revision
        )
        setMessage(
          "Sample mappings saved. Assistant configuration was not saved."
        )
        router.refresh()
      } else throw new Error("Invalid sample response")
    } catch {
      store.conflict("samples", state.sampleRevision)
      setMessage(
        "Could not confirm the sample save. Your draft is kept. Fetch the latest saved version before retrying; revision checks prevent overwriting a newer save."
      )
      router.refresh()
    } finally {
      store.setSaving(false)
    }
  }
  return (
    <Card className="rounded-lg shadow-none">
      <CardHeader>
        <CardTitle>
          <h2>Sample responses</h2>
        </CardTitle>
        <CardDescription>
          Fictional data only. Every tool needs an authored default. Named
          overrides are optional. Previewing captures this draft without saving
          it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <p className="text-sm text-muted-foreground">
          Saved sample revision {state.sampleRevision} ·{" "}
          {samplesDirty(state) ? "Unsaved sample draft" : "Saved samples"}. JSON
          null is an explicit result; a blank field is missing.
        </p>
        <fieldset disabled={locked} className="min-w-0 space-y-5">
          <legend className="sr-only">Sample mappings</legend>
          {state.samples.map((row, index) => {
            const tool = tools.find((item) => item.name === row.toolName)
            const reviewed =
              tool !== undefined &&
              row.inputSchemaFingerprint === tool.fingerprint &&
              row.reviewedFingerprint === tool.fingerprint
            return (
              <section
                key={index}
                className="min-w-0 space-y-3 rounded-md border p-4"
                aria-label={`Sample ${row.toolName}`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold break-all">
                    {row.toolName}
                  </h3>
                  <Button
                    type="button"
                    variant="ghost"
                    className="min-h-11"
                    onClick={() => {
                      if (
                        window.confirm(
                          `Remove the sample mapping for ${row.toolName}?`
                        )
                      )
                        store.editSamples(
                          state.samples.filter(
                            (_, position) => position !== index
                          )
                        )
                    }}
                  >
                    Remove mapping
                  </Button>
                </div>
                <p className="text-sm text-muted-foreground">
                  {state.validation === null
                    ? "Checking tool schema…"
                    : tool === undefined
                      ? "This tool is no longer present. Remove its mapping or choose its replacement below."
                      : reviewed
                        ? "Reviewed against this tool’s current input schema."
                        : "Tool input changed or has not been reviewed. Review the schema and sample results, then confirm below."}
                </p>
                {tool === undefined && tools.length > 0 && (
                  <label className="block space-y-2 text-sm">
                    Replacement tool
                    <select
                      className="min-h-11 w-full rounded-md border bg-background px-3"
                      value=""
                      onChange={(event) => {
                        if (event.target.value)
                          edit(index, {
                            toolName: event.target.value,
                            reviewedFingerprint: "",
                          })
                      }}
                    >
                      <option value="">Choose a tool…</option>
                      {tools
                        .filter(
                          (item) =>
                            !state.samples.some(
                              (sample) => sample.toolName === item.name
                            )
                        )
                        .map((item) => (
                          <option key={item.name} value={item.name}>
                            {item.name}
                          </option>
                        ))}
                    </select>
                  </label>
                )}
                {tool !== undefined && (
                  <details className="rounded-md bg-muted/40 p-3">
                    <summary className="cursor-pointer text-sm">
                      Review {tool.name} input schema
                    </summary>
                    <pre className="mt-3 max-h-64 overflow-auto text-xs break-all whitespace-pre-wrap">
                      {JSON.stringify(tool.parameters, null, 2)}
                    </pre>
                  </details>
                )}
                <label
                  className="block space-y-2 text-sm"
                  htmlFor={`sample-default-${index}`}
                >
                  Default result (JSON)
                  <Textarea
                    id={`sample-default-${index}`}
                    value={row.defaultText}
                    onChange={(event) =>
                      edit(index, { defaultText: event.target.value })
                    }
                    maxLength={16 * 1024}
                    rows={6}
                    className="min-h-32 font-mono text-xs"
                    spellCheck={false}
                  />
                </label>
                <label
                  className="block space-y-2 text-sm"
                  htmlFor={`sample-overrides-${index}`}
                >
                  Named overrides (JSON array)
                  <Textarea
                    id={`sample-overrides-${index}`}
                    value={row.overridesText}
                    onChange={(event) =>
                      edit(index, { overridesText: event.target.value })
                    }
                    maxLength={64 * 1024}
                    rows={5}
                    className="min-h-28 font-mono text-xs"
                    spellCheck={false}
                  />
                </label>
                <p className="text-xs text-muted-foreground">
                  Use [] for no overrides, or objects with a name and result:{" "}
                  {`[{"name":"unavailable","result":null}]`}. Names use letters,
                  numbers, underscores or hyphens. Each result must fit within
                  16 KiB; all mappings together within 64 KiB.
                </p>
                {tool !== undefined && !reviewed && (
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11 whitespace-normal"
                    disabled={readSampleDrafts([row]).issues.length > 0}
                    onClick={() =>
                      edit(index, {
                        inputSchemaFingerprint: tool.fingerprint,
                        reviewedFingerprint: tool.fingerprint,
                      })
                    }
                  >
                    I reviewed this schema and its sample results
                  </Button>
                )}
              </section>
            )
          })}
          {tools
            .filter(
              (tool) => !state.samples.some((row) => row.toolName === tool.name)
            )
            .map((tool) => (
              <Button
                key={tool.name}
                type="button"
                variant="outline"
                className="min-h-11 max-w-full break-all whitespace-normal"
                onClick={() =>
                  store.editSamples([
                    ...state.samples,
                    {
                      toolName: tool.name,
                      inputSchemaFingerprint: tool.fingerprint,
                      reviewedFingerprint: "",
                      defaultText: "",
                      overridesText: "[]",
                    },
                  ])
                }
              >
                Author sample for {tool.name}
              </Button>
            ))}
          {tools.length === 0 && state.samples.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No sample mappings. Add valid tools in Configure to author their
              results here.
            </p>
          )}
        </fieldset>
        {[...parsed.issues, ...sampleIssues].length > 0 && (
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {[...parsed.issues, ...sampleIssues].map((issue, index) => (
              <li key={index}>{issue.message}</li>
            ))}
          </ul>
        )}
        {toolsUnsaved && (
          <p className="text-sm text-muted-foreground">
            These mappings use unsaved tools. You can preview them now. Save the
            assistant in Configure before saving these sample mappings.
          </p>
        )}
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={!canSave}
          onClick={() => {
            void save()
          }}
        >
          Save sample mappings
        </Button>
        {message !== null && (
          <p role="status" className="text-sm">
            {message}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
