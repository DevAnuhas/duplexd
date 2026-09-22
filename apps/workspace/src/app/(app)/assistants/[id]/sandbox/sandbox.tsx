"use client"

import {
  Microphone,
  SpeakerHigh,
  Flask,
  ArrowUpRight,
} from "@phosphor-icons/react"
import Link from "next/link"
import { useEffect, useState } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import type { PracticeScenario } from "@/practice/configuration"
import { readPreview, readSampleDrafts } from "@/sandbox/client/draft-store"
import { useAssistantDraft } from "../draft-host"
import { SampleEditor } from "./sample-editor"
import {
  LocalAudioCheck,
  type LocalAudioState,
} from "@/sandbox/client/local-audio"
import { AssistantNavigation } from "../../assistant-navigation"

export type SandboxProps = {
  assistant: {
    id: string
    name: string
    revision: number
    voice: string | null
    backendModel: string | null
  }
}

type Scenario = "success" | "unavailable" | "slow" | "failure"
const scenarios: Array<{
  value: Scenario
  label: string
  description: string
}> = [
  {
    value: "success",
    label: "Default responses",
    description: "Use each tool’s explicit default sample.",
  },
  {
    value: "unavailable",
    label: "Information unavailable",
    description:
      "Use an unavailable override where authored; other tools use their defaults.",
  },
  {
    value: "slow",
    label: "Slow response",
    description: "Add a bounded delay to the sample response.",
  },
  {
    value: "failure",
    label: "Tool failure",
    description:
      "Return a controlled delivery failure, without inventing a result.",
  },
]

export function Sandbox({ assistant }: SandboxProps) {
  const {
    store,
    state: draft,
    controller,
    attempt: state,
    locked,
  } = useAssistantDraft()
  const parsedSamples = readSampleDrafts(draft.samples)
  const samples = parsedSamples.definitions.flatMap((value) => {
    const item = value as { toolName: string; overrides: unknown }
    return [
      {
        toolName: item.toolName,
        overrides: Array.isArray(item.overrides)
          ? item.overrides.filter(
              (override): override is { name: string; result: unknown } =>
                override !== null &&
                typeof override === "object" &&
                typeof override.name === "string"
            )
          : [],
      },
    ]
  })
  const selected = draft.source === "preview" ? draft.fields : draft.saved
  const issues = draft.validation?.issues ?? [
    {
      field: "validation",
      message: "Checking configuration and sample coverage…",
    },
  ]
  const conflict =
    draft.assistantConflict !== null || draft.sampleConflict !== null
  const [namedOverrides, setNamedOverrides] = useState<Record<string, string>>(
    {}
  )
  const [scenario, setScenario] = useState<Scenario>("success")
  const [audioState, setAudioState] = useState<LocalAudioState>({
    kind: "idle",
    message: "Audio checks run locally. Nothing is recorded or sent.",
    level: 0,
  })
  const [audio] = useState(() => new LocalAudioCheck(setAudioState))
  const busy = ["loading", "preparing", "canceling"].includes(state.phase)
  const unresolved =
    state.attempt !== null &&
    !["canceled", "expired"].includes(state.attempt.state)
  const listening =
    audioState.kind === "listening" || audioState.kind === "requesting"
  const unavailableCount = samples.filter((sample) =>
    sample.overrides.some((override) => override.name === "unavailable")
  ).length

  useEffect(() => {
    const release = () => {
      audio.stop()
      setAudioState({
        kind: "stopped",
        message: "Local audio stopped. No voice call is connected.",
        level: 0,
      })
    }
    const visibility = () => {
      if (document.hidden) release()
    }
    window.addEventListener("pagehide", release)
    document.addEventListener("visibilitychange", visibility)
    return () => {
      window.removeEventListener("pagehide", release)
      document.removeEventListener("visibilitychange", visibility)
      audio.stop()
    }
  }, [audio])

  async function prepare() {
    audio.stop()
    setAudioState({
      kind: "stopped",
      message: "Local audio stopped before preparation.",
      level: 0,
    })
    const overrides =
      scenario === "unavailable"
        ? Object.fromEntries(
            samples
              .filter((sample) =>
                sample.overrides.some(
                  (override) => override.name === "unavailable"
                )
              )
              .map((sample) => [sample.toolName, "unavailable"])
          )
        : Object.fromEntries(
            Object.entries(namedOverrides).filter(([toolName, name]) =>
              samples.some(
                (sample) =>
                  sample.toolName === toolName &&
                  sample.overrides.some((override) => override.name === name)
              )
            )
          )
    const selectedScenario: PracticeScenario = {
      transport: scenario === "unavailable" ? "success" : scenario,
      overrides,
    }
    const preview = readPreview(draft.fields)
    if (
      !state.canRetryPreparation &&
      (locked ||
        conflict ||
        issues.length > 0 ||
        parsedSamples.issues.length > 0 ||
        (draft.source === "preview" && preview.issues.length > 0))
    )
      return
    await controller.prepare({
      assistantId: assistant.id,
      baseRevision: draft.baseRevision,
      source: draft.source,
      ...(draft.source === "preview" ? { preview: preview.preview } : {}),
      sampleRevision: draft.sampleRevision,
      samples: parsedSamples.definitions,
      scenario: selectedScenario,
    })
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <Link
            href="/assistants"
            className="inline-flex min-h-11 items-center text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
          >
            Assistants
          </Link>
          <h1 className="text-3xl font-semibold tracking-tight break-words">
            {assistant.name}
          </h1>
          <p className="mt-2 text-muted-foreground">
            Prepare a test, check your audio, and review what will run.
          </p>
        </div>
        <Badge variant="secondary" className="mt-3">
          Practice · sample data
        </Badge>
      </header>
      <AssistantNavigation assistantId={assistant.id} active="sandbox" />

      <section
        aria-labelledby="availability-title"
        className="flex items-start gap-3 rounded-lg border bg-muted/30 p-5"
      >
        <Flask className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
        <div className="min-w-0">
          <h2 id="availability-title" className="font-semibold">
            Voice calls are not available yet
          </h2>
          <p className="mt-1 max-w-3xl text-sm leading-relaxed text-muted-foreground">
            You can prepare a Practice test and check local audio. Starting a
            voice call is disabled while runtime safety checks are unfinished.
            Preparation starts no agent and incurs no voice/model usage.
          </p>
        </div>
      </section>

      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-6">
          <Card className="rounded-lg shadow-none">
            <CardHeader>
              <CardTitle>
                <h2>Test configuration</h2>
              </CardTitle>
              <CardDescription>
                Based on saved revision {draft.baseRevision}. Preview never
                saves the assistant or its samples.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <fieldset disabled={locked} className="flex flex-wrap gap-4">
                <legend className="mb-3 text-sm font-semibold">
                  Configuration source
                </legend>
                {(["saved", "preview"] as const).map((source) => (
                  <label
                    key={source}
                    className="flex min-h-11 items-center gap-2 text-sm"
                  >
                    <input
                      type="radio"
                      name="configuration-source"
                      value={source}
                      checked={draft.source === source}
                      onChange={() => store.setSource(source)}
                      className="size-4 accent-primary"
                    />
                    {source === "saved"
                      ? "Saved configuration"
                      : "Unsaved conversation preview"}
                  </label>
                ))}
              </fieldset>
              <p className="text-sm text-muted-foreground">
                {draft.source === "preview"
                  ? "Uses your in-tab conversation, voice, model and tools draft. Name, connection URL and credentials are excluded."
                  : "Uses the saved assistant configuration. Sample responses below are included as shown, even when unsaved."}
              </p>
              <dl className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <dt className="text-muted-foreground">Voice</dt>
                  <dd className="mt-1 font-medium break-words">
                    {selected.voice || "Not configured"}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Backend model</dt>
                  <dd className="mt-1 font-medium break-words">
                    {selected.backendModel || "Not configured"}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Channel</dt>
                  <dd className="mt-1 font-medium">Browser</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Configuration</dt>
                  <dd className="mt-1 font-medium">
                    {draft.source === "preview" ? "Unsaved preview" : "Saved"} ·
                    Practice
                  </dd>
                </div>
              </dl>
              {issues.length > 0 ? (
                <div className="space-y-3 rounded-md border p-4">
                  <h3 className="text-sm font-semibold">
                    Fix these before preparing
                  </h3>
                  <ul className="list-disc space-y-2 pl-5 text-sm">
                    {issues.map((issue, index) => (
                      <li
                        key={`${issue.field}-${index}`}
                        className="break-words"
                      >
                        {issue.message}
                      </li>
                    ))}
                  </ul>
                  <Button asChild variant="outline" className="min-h-11">
                    <Link href={`/assistants/${assistant.id}`}>
                      Edit configuration
                    </Link>
                  </Button>
                  <p className="text-sm text-muted-foreground">
                    Custom sample editing is not available here yet. To try a
                    complete sample mapping, create a{" "}
                    <Link
                      className="underline underline-offset-4"
                      href="/assistants/new?template=riley"
                    >
                      Riley sample assistant
                    </Link>
                    .
                  </p>
                </div>
              ) : (
                <p className="text-sm">
                  Selected configuration and sample coverage pass preparation
                  checks. This does not mean a voice agent is ready.
                </p>
              )}
              <fieldset disabled={locked} className="space-y-3">
                <legend className="mb-3 text-sm font-semibold">
                  Sample scenario
                </legend>
                {scenarios.map((option) => (
                  <label
                    key={option.value}
                    className="flex cursor-pointer items-start gap-3 rounded-md border p-3 has-[:checked]:border-primary has-[:checked]:bg-muted/50 has-[:disabled]:cursor-default has-[:disabled]:opacity-60"
                  >
                    <input
                      className="mt-1 size-4 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-ring"
                      type="radio"
                      name="scenario"
                      value={option.value}
                      checked={scenario === option.value}
                      onChange={() => setScenario(option.value)}
                      disabled={
                        locked ||
                        (option.value === "unavailable" &&
                          unavailableCount === 0)
                      }
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">
                        {option.label}
                      </span>
                      <span className="mt-1 block text-sm text-muted-foreground">
                        {option.description}
                      </span>
                    </span>
                  </label>
                ))}
              </fieldset>
              {scenario === "unavailable" && (
                <p className="text-sm text-muted-foreground">
                  {unavailableCount} of {samples.length} tools have an
                  unavailable override. Remaining tools use their explicit
                  default sample.
                </p>
              )}
              {scenario !== "unavailable" && (
                <fieldset disabled={locked} className="space-y-3">
                  <legend className="mb-3 text-sm font-semibold">
                    Named sample overrides
                  </legend>
                  {samples
                    .filter((sample) => sample.overrides.length > 0)
                    .map((sample) => (
                      <label
                        key={sample.toolName}
                        className="block space-y-2 text-sm"
                      >
                        {sample.toolName}
                        <select
                          className="min-h-11 w-full rounded-md border bg-background px-3"
                          value={
                            sample.overrides.some(
                              (override) =>
                                override.name ===
                                namedOverrides[sample.toolName]
                            )
                              ? namedOverrides[sample.toolName]
                              : ""
                          }
                          onChange={(event) =>
                            setNamedOverrides((current) => ({
                              ...current,
                              [sample.toolName]: event.target.value,
                            }))
                          }
                        >
                          <option value="">Default result</option>
                          {sample.overrides.map((override) => (
                            <option key={override.name} value={override.name}>
                              {override.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    ))}
                </fieldset>
              )}
            </CardContent>
          </Card>
          <SampleEditor />
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          <Card className="rounded-lg shadow-none">
            <CardHeader>
              <CardTitle>
                <h2>Check your audio</h2>
              </CardTitle>
              <CardDescription>
                Local checks only. These never place a call.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  className="min-h-11"
                  onClick={() => {
                    void audio.microphone()
                  }}
                  disabled={listening}
                >
                  <Microphone className="size-4" aria-hidden="true" />
                  Check microphone
                </Button>
                <Button
                  variant="outline"
                  className="min-h-11"
                  onClick={() => {
                    void audio.sound()
                  }}
                  disabled={listening}
                >
                  <SpeakerHigh className="size-4" aria-hidden="true" />
                  Play test sound
                </Button>
                {listening && (
                  <Button
                    variant="secondary"
                    className="min-h-11"
                    onClick={() => {
                      audio.stop()
                      setAudioState({
                        kind: "stopped",
                        message: "Microphone capture is off.",
                        level: 0,
                      })
                    }}
                  >
                    Stop audio check
                  </Button>
                )}
              </div>
              <p
                role="status"
                className="text-sm leading-relaxed text-muted-foreground"
              >
                {audioState.message}
              </p>
              {audioState.kind === "listening" && (
                <meter
                  aria-label="Microphone input level"
                  min={0}
                  max={100}
                  value={audioState.level}
                  className="h-3 w-full"
                />
              )}
            </CardContent>
          </Card>
          <Card className="rounded-lg shadow-none">
            <CardHeader>
              <CardTitle>
                <h2>Prepare your test</h2>
              </CardTitle>
              <CardDescription>
                One preparation at a time, across your tabs. An unused
                reservation expires after 30 seconds.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div
                role="status"
                aria-live="polite"
                className="space-y-2 text-sm"
              >
                {state.phase === "loading" && <p>Checking existing tests…</p>}
                {state.phase === "preparing" && (
                  <p>Preparing the selected snapshot…</p>
                )}
                {state.phase === "canceling" && <p>Canceling preparation…</p>}
                {state.message !== null && (
                  <p className="break-words">{state.message}</p>
                )}
                {state.attempt !== null && (
                  <div className="rounded-md border p-4">
                    <p className="font-medium">
                      {state.attempt.state === "prepared"
                        ? "Test prepared · voice not started"
                        : state.attempt.state === "canceled"
                          ? "Preparation canceled"
                          : state.attempt.state === "expired"
                            ? "Preparation expired"
                            : "Existing test needs attention"}
                    </p>
                    <p className="mt-2 text-muted-foreground">
                      {state.attempt.assistantId !== assistant.id
                        ? "This test belongs to another assistant. You can inspect or cancel it here."
                        : "This is a saved Practice attempt, not a completed voice call."}
                    </p>
                    <Link
                      className="mt-3 inline-flex min-h-11 items-center gap-1 underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring"
                      href={`/calls/${state.attempt.callId}`}
                    >
                      View test record
                      <ArrowUpRight className="size-4" aria-hidden="true" />
                    </Link>
                  </div>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  className="min-h-11"
                  disabled={
                    busy ||
                    unresolved ||
                    (!state.canRetryPreparation &&
                      (issues.length > 0 || conflict || draft.saving)) ||
                    (state.phase === "error" &&
                      state.attempt === null &&
                      !state.canRetryPreparation)
                  }
                  onClick={() => {
                    void prepare()
                  }}
                >
                  {state.canRetryPreparation
                    ? "Retry same preparation"
                    : "Prepare test"}
                </Button>
                {unresolved && (
                  <Button
                    variant="outline"
                    className="min-h-11"
                    disabled={busy}
                    onClick={() => {
                      audio.stop()
                      void controller.cancel()
                    }}
                  >
                    Cancel preparation
                  </Button>
                )}
                <Button
                  variant="ghost"
                  className="min-h-11"
                  disabled={busy}
                  onClick={() => {
                    void controller.refresh()
                  }}
                >
                  Refresh status
                </Button>
              </div>
              <div className="border-t pt-4">
                <Button
                  className="min-h-11 w-full"
                  disabled
                  aria-describedby="voice-disabled"
                >
                  Start voice call
                </Button>
                <p
                  id="voice-disabled"
                  className="mt-2 text-sm text-muted-foreground"
                >
                  Voice execution is disabled. No microphone stream is attached
                  to this test.
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
