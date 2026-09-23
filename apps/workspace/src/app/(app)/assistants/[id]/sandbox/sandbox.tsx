"use client"

import {
  Microphone,
  SpeakerHigh,
  Flask,
  ArrowUpRight,
} from "@phosphor-icons/react"
import Link from "next/link"
import { useEffect, useRef, useState } from "react"

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
import { sandboxReleased } from "@/sandbox/client/controller"
import { SANDBOX_LIMITS } from "@/sandbox/protocol"
import {
  preparationBlock,
  preparationBlockMessage,
  sandboxPanelPhase,
  type SandboxPanelPhase,
} from "@/sandbox/client/panel-phase"
import { DailySandboxMedia } from "@/sandbox/client/daily-media"
import type { SandboxMediaEvent } from "@/sandbox/client/media"
import { LiveSandboxTimeline } from "@/components/sandbox/timeline"
import { useOptionalPracticeSession } from "@/components/sandbox/practice-session"
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

function elapsed(remaining: number) {
  const total = Math.max(
    0,
    Math.floor((SANDBOX_LIMITS.executionMs - remaining) / 1000)
  )
  const minutes = Math.floor(total / 60)
  return `${minutes}:${String(total % 60).padStart(2, "0")}`
}

/**
 * Ticks once a second while a deadline is displayed.
 *
 * `performance.now()`, not `Date.now()`, and it is not a preference. The
 * controller's deadlines are computed against its own clock, which is
 * `performance.now()` — milliseconds since the page loaded, not a Unix epoch.
 * Subtracting one from the other is off by about fifty-six years, and the
 * symptom is not a subtle drift: every live call renders "Call time limit
 * reached" the instant it connects.
 *
 * It is also the right clock on its own merits. A timer wants a monotonic
 * source, so that a system clock correction mid-call cannot make the remaining
 * time jump backwards or stall.
 */
function useNow(active: boolean) {
  const [now, setNow] = useState(() => performance.now())
  useEffect(() => {
    if (!active) return
    setNow(performance.now())
    const timer = setInterval(() => setNow(performance.now()), 1_000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

const CONNECTING_LABEL: Record<string, string> = {
  checking: "Checking local audio",
  starting: "Starting agent",
  joining: "Connecting audio",
  waiting: "Waiting for agent readiness",
}

/** The headline for each phase. One phase, one thing the panel is for. */
const PHASE_HEADLINE: Record<SandboxPanelPhase, string> = {
  loading: "Checking existing tests…",
  idle: "Ready to practice",
  prepared: "Ready to call",
  connecting: "Calling assistant…",
  live: "Connected",
  reconnecting: "Reconnecting…",
  finishing: "Ending call…",
  cleanup: "Ending call…",
  finished: "Call stopped · review the record",
  error: "Preparation could not continue",
}

/**
 * `finished` is reached by three different routes, and which one it was is the
 * person's business.
 *
 * Collapsing canceled, expired and released into one phase is right for
 * *controls* — all three offer exactly the same actions, which is the job
 * `sandboxPanelPhase` exists to do. It is wrong for the headline. Before the
 * phase rewrite this panel said "Preparation canceled" and "Preparation
 * expired"; folding both into a sentence about resources answers a question
 * about the system instead of the one the person asked, which is what happened
 * to their test.
 *
 * "I cancelled this", "it expired while I was away" and "the call ended" are
 * not the same fact.
 */
function phaseHeadline(
  phase: SandboxPanelPhase,
  attemptState: string | null
): string {
  if (phase !== "finished") return PHASE_HEADLINE[phase]
  if (attemptState === "canceled") return "Preparation canceled"
  if (attemptState === "expired") return "Preparation expired"
  return PHASE_HEADLINE.finished
}

export function Sandbox({ assistant }: SandboxProps) {
  const session = useOptionalPracticeSession()
  const sharedSession = session !== null
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
  const [callStarting, setCallStarting] = useState(false)
  const [callError, setCallError] = useState<string | null>(null)
  const pendingMedia = useRef<DailySandboxMedia | null>(null)
  const mounted = useRef(true)
  const busy = ["loading", "preparing", "canceling"].includes(state.phase)
  const unresolved = state.attempt !== null && !sandboxReleased(state.attempt)
  const foreignId = state.attempt?.assistantId
  const foreignAttempt =
    unresolved && typeof foreignId === "string" && foreignId !== assistant.id
  const foreignName = foreignId
    ? (session?.names[foreignId] ?? "another assistant")
    : "another assistant"
  const listening =
    audioState.kind === "listening" || audioState.kind === "requesting"
  const unavailableCount = samples.filter((sample) =>
    sample.overrides.some((override) => override.name === "unavailable")
  ).length
  const [endedReason, setEndedReason] = useState<string | null>(null)
  const panelPhase = sandboxPanelPhase(state)
  // Validation pending is "checking", not "broken": `issues` carries a
  // placeholder entry until the draft validates, and calling that a
  // configuration fault would tell people to fix something that is fine.
  const validating = draft.validation == null
  const previewIssues =
    draft.source === "preview" ? readPreview(draft.fields).issues.length : 0
  // One predicate, both consumers — the button's disabled state and the click
  // handler's own guard read this single value.
  const block = preparationBlock({
    canRetryPreparation: state.canRetryPreparation,
    busy: busy || validating || callStarting,
    unresolved,
    locked,
    saving: draft.saving,
    conflict,
    configurationIssues: draft.validation?.issues.length ?? 0,
    sampleIssues: parsedSamples.issues.length,
    previewIssues,
  })
  const counting = ["prepared", "connecting", "live", "reconnecting"].includes(
    panelPhase
  )
  const now = useNow(counting)
  const left = (deadline: number) => (deadline > 0 ? deadline - now : null)
  const reservationLeft = left(state.deadlines.reservation)
  const startupLeft = left(state.deadlines.startup)
  const executionLeft = left(state.deadlines.execution)

  useEffect(() => {
    session?.rememberName(assistant.id, assistant.name)
  }, [session, assistant.id, assistant.name])

  useEffect(() => {
    mounted.current = true
    const release = (reason: string | null, keepCall = false) => {
      audio.stop()
      pendingMedia.current?.stop()
      pendingMedia.current = null
      if (!sharedSession && !keepCall) controller.leave()
      if (reason !== null) setEndedReason(reason)
      setAudioState({
        kind: "stopped",
        message: "Local audio check stopped.",
        level: 0,
      })
    }
    const leaving = () => release(null)
    const visibility = () => {
      if (document.hidden) {
        const continues = sharedSession
          ? controller.canContinueHidden()
          : controller.hidden()
        release(
          continues
            ? null
            : "Practice stopped before the call connected because this tab was hidden. Start a new call when you are ready.",
          continues
        )
      }
    }
    window.addEventListener("pagehide", leaving)
    document.addEventListener("visibilitychange", visibility)
    return () => {
      mounted.current = false
      window.removeEventListener("pagehide", leaving)
      document.removeEventListener("visibilitychange", visibility)
      audio.stop()
      pendingMedia.current?.stop()
      pendingMedia.current = null
      if (!sharedSession) controller.leave()
    }
  }, [audio, controller, sharedSession])

  async function prepare() {
    // Before any side effect. This used to stop local audio and *then* decide
    // it could not continue, which looked exactly like a dead button.
    if (block !== null) return
    setEndedReason(null)
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

  async function startNewCall() {
    if (block !== null) return
    setCallStarting(true)
    setCallError(null)
    let forward: ((event: SandboxMediaEvent) => void) | null = null
    const media = new DailySandboxMedia((event) => forward?.(event))
    pendingMedia.current = media
    try {
      // Capture and playback unlock begin in the click stack. The reservation
      // is created only after the permission prompt completes.
      await media.prepare()
      if (!mounted.current || pendingMedia.current !== media) return
      await prepare()
      if (!mounted.current || pendingMedia.current !== media) {
        if (controller.canStart()) void controller.cancel()
        return
      }
      if (!controller.canStart()) return
      await controller.start((report) => {
        forward = report
        pendingMedia.current = null
        return media
      }, true)
    } catch {
      if (mounted.current)
        setCallError(
          "Microphone or playback could not be opened. Check browser permissions and try again."
        )
    } finally {
      if (pendingMedia.current === media) {
        media.stop()
        pendingMedia.current = null
      }
      if (mounted.current) setCallStarting(false)
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b pb-4">
        <div className="min-w-0 flex-1">
          <Link
            href="/assistants"
            className="inline-flex items-center text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
          >
            Assistants
          </Link>
          <h1 className="text-xl font-semibold tracking-tight break-words">
            {assistant.name}
          </h1>
        </div>
        <Badge variant="secondary" className="text-xs">
          Sample data
        </Badge>
      </header>
      <AssistantNavigation assistantId={assistant.id} active="practice" />

      {/* Only claim voice is unavailable when the server actually said so. The
          condition used to be `!== "enabled"`, which is also true when there is
          no attempt yet — so a fresh page announced that voice calls were
          disabled before it had asked. */}
      {state.attempt !== null && state.attempt.execution !== "enabled" && (
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
      )}

      <div className="flex min-w-0 flex-col gap-4">
        <details className="order-2 min-w-0 rounded-lg border p-3">
          <summary className="cursor-pointer text-sm font-medium">
            Practice settings and sample responses
          </summary>
          <div className="mt-4 flex min-w-0 flex-col gap-4">
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
                      {draft.source === "preview" ? "Unsaved preview" : "Saved"}{" "}
                      · Practice
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
                      Review the sample mappings below. For a complete starting
                      example, create a{" "}
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
                {["idle", "error", "finished"].includes(panelPhase) && (
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    disabled={block !== null}
                    onClick={() => {
                      void prepare()
                    }}
                  >
                    Prepare without calling
                  </Button>
                )}
              </CardContent>
            </Card>
            <SampleEditor />
          </div>
        </details>
        <div className="order-1 grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,0.8fr)]">
          <Card className="order-2 gap-3 rounded-lg py-4 shadow-none">
            <CardHeader className="px-4">
              <CardTitle>
                <h2 className="text-sm">Audio check</h2>
              </CardTitle>
              <CardDescription className="text-xs">
                Local checks only. These never place a call.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 px-4">
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  className="h-8"
                  onClick={() => {
                    void audio.microphone()
                  }}
                  disabled={listening || state.mediaPhase !== "off"}
                >
                  <Microphone className="size-4" aria-hidden="true" />
                  Check microphone
                </Button>
                <Button
                  variant="outline"
                  className="h-8"
                  onClick={() => {
                    void audio.sound()
                  }}
                  disabled={listening || state.mediaPhase !== "off"}
                >
                  <SpeakerHigh className="size-4" aria-hidden="true" />
                  Play test sound
                </Button>
                {listening && (
                  <Button
                    variant="secondary"
                    className="h-8"
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
          <Card className="order-1 gap-3 rounded-lg py-4 shadow-none">
            <CardHeader className="px-4">
              <CardTitle>
                <h2 className="text-sm">Talk to {assistant.name}</h2>
              </CardTitle>
              <CardDescription className="text-xs">
                {foreignAttempt
                  ? `A Practice call with ${foreignName} is active.`
                  : "Try a conversation with sample responses from your tools."}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 px-4">
              {foreignAttempt && state.attempt ? (
                <div className="space-y-4" role="status">
                  <p className="font-medium">
                    Practice call with {foreignName} is active
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Finish that call before starting one with {assistant.name}.
                    You can still edit this assistant’s configuration.
                  </p>
                  <Button asChild variant="outline" className="min-h-11">
                    <Link
                      href={`/assistants/${encodeURIComponent(foreignId ?? "")}/sandbox`}
                    >
                      View active Practice call
                    </Link>
                  </Button>
                </div>
              ) : (
                <>
                  <div
                    role="status"
                    aria-live="polite"
                    className="space-y-2 text-sm"
                  >
                    <p className="font-medium">
                      {callStarting && state.mediaPhase === "off"
                        ? "Starting practice call…"
                        : phaseHeadline(
                            panelPhase,
                            state.attempt?.state ?? null
                          )}
                    </p>
                    {callError && <p role="alert">{callError}</p>}
                    {panelPhase === "prepared" &&
                      reservationLeft !== null &&
                      reservationLeft <= 0 && (
                        <p className="text-muted-foreground">
                          Ready window expired. Prepare again.
                        </p>
                      )}
                    {panelPhase === "connecting" && (
                      <p className="text-muted-foreground">
                        {CONNECTING_LABEL[state.mediaPhase] ?? "Connecting"}
                        {startupLeft !== null &&
                          startupLeft <= 0 &&
                          " · The assistant did not become ready in time."}
                      </p>
                    )}
                    {!sharedSession &&
                      (panelPhase === "live" ||
                        panelPhase === "reconnecting") && (
                        <p className="text-muted-foreground">
                          {executionLeft === null
                            ? "Practice uses sample data."
                            : executionLeft > 0
                              ? `${elapsed(executionLeft)} elapsed · Practice uses sample data.`
                              : "Call time limit reached."}
                        </p>
                      )}
                    {/* Not gated on `mediaPhase === "off"`. Hiding the tab ends the
                    call *through* cleanup, so the panel sits in `finishing`
                    for a while — which is exactly when someone is staring at
                    it wondering what went wrong. Gating on "off" hid this
                    message during the only moments it was needed. */}
                    {/* Advisory, never fatal, and it withdraws itself when output
                    resumes. The call keeps running either way — ending it on
                    this signal would be one more control that stops a call
                    without explaining why. */}
                    {state.outputSilent &&
                      (panelPhase === "live" ||
                        panelPhase === "reconnecting") && (
                        <p className="rounded-md border p-3">
                          You may not be able to hear the assistant. Check your
                          output device and volume.
                        </p>
                      )}
                    {endedReason !== null && panelPhase !== "live" && (
                      <p className="rounded-md border p-3 break-words">
                        {endedReason}
                      </p>
                    )}
                    {state.message !== null &&
                      ["error", "cleanup", "finishing"].includes(
                        panelPhase
                      ) && <p className="break-words">{state.message}</p>}
                    {block !== null &&
                      ["idle", "finished", "error"].includes(panelPhase) && (
                        <p className="text-muted-foreground">
                          {preparationBlockMessage[block]}
                        </p>
                      )}
                    {state.attempt !== null && panelPhase !== "finished" && (
                      <details className="rounded-md border p-4">
                        <summary className="cursor-pointer font-medium">
                          Call details
                        </summary>
                        <p className="text-muted-foreground">
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
                      </details>
                    )}
                  </div>

                  {/* The primary slot. Always occupies the same place, and holds
                  only non-destructive actions, so End call can never inherit
                  the coordinates Start voice call had a moment earlier. */}
                  <div className="min-h-11">
                    {(panelPhase === "idle" || panelPhase === "error") && (
                      <Button
                        className="min-h-11 w-full"
                        disabled={block !== null}
                        onClick={() => {
                          void startNewCall()
                        }}
                      >
                        {state.canRetryPreparation
                          ? "Retry preparation"
                          : "Start practice call"}
                      </Button>
                    )}
                    {panelPhase === "prepared" && (
                      <Button
                        className="min-h-11 w-full"
                        disabled={!controller.canStart()}
                        onClick={() => {
                          setEndedReason(null)
                          audio.stop()
                          void controller.start(
                            (report) => new DailySandboxMedia(report)
                          )
                        }}
                      >
                        Start prepared call
                      </Button>
                    )}
                    {panelPhase === "finished" && state.attempt !== null && (
                      <Button asChild className="min-h-11 w-full">
                        <Link href={`/calls/${state.attempt.callId}`}>
                          View test record
                        </Link>
                      </Button>
                    )}
                  </div>

                  {/* Secondary region. This is what reflows between phases. */}
                  <div className="flex flex-wrap gap-2 empty:hidden">
                    {panelPhase === "prepared" && (
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
                    {!sharedSession &&
                      (panelPhase === "live" ||
                        panelPhase === "reconnecting") && (
                        <Button
                          variant="outline"
                          className="min-h-11"
                          aria-pressed={state.muted}
                          onClick={() => controller.mute()}
                        >
                          {state.muted
                            ? "Unmute microphone"
                            : "Mute microphone"}
                        </Button>
                      )}
                    {panelPhase === "finished" && (
                      <Button
                        variant="outline"
                        className="min-h-11"
                        disabled={block !== null}
                        onClick={() => {
                          void startNewCall()
                        }}
                      >
                        Start another call
                      </Button>
                    )}
                    {["cleanup", "finishing", "error"].includes(panelPhase) && (
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
                    )}
                  </div>

                  {/* Danger region: always last, always separated, never merged
                  into the row above. */}
                  {!sharedSession &&
                    [
                      "connecting",
                      "live",
                      "reconnecting",
                      "finishing",
                      "cleanup",
                    ].includes(panelPhase) && (
                      <div className="border-t pt-4">
                        <Button
                          variant="destructive"
                          className="min-h-11"
                          onClick={() => {
                            void controller.end()
                          }}
                        >
                          {panelPhase === "finishing" ||
                          panelPhase === "cleanup"
                            ? "Retry stop"
                            : "End call"}
                        </Button>
                      </div>
                    )}

                  {panelPhase === "prepared" && (
                    <p className="text-sm text-muted-foreground">
                      {!state.ownsController
                        ? "This tab can observe or stop this test. Only its original controller can start or join it."
                        : "Start checks microphone and playback before dispatch. Calls are limited to 10 minutes. Keep this window visible and in front; hiding it or switching away stops the call."}
                    </p>
                  )}
                </>
              )}
            </CardContent>
          </Card>
          {!sharedSession && state.attempt && (
            <LiveSandboxTimeline
              key={state.attempt.callId}
              callId={state.attempt.callId}
            />
          )}
        </div>
      </div>
    </div>
  )
}
