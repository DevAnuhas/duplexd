import Link from "next/link"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { HistoricalSandboxTimeline } from "@/components/calls/historical-sandbox-timeline"
import { ObservationEditor } from "@/components/calls/observation-editor"
import type { ReviewEvent, WorkspaceCall } from "@/data/calls"
import type { Observation } from "@/data/observations"

const dateTime = new Intl.DateTimeFormat("en", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short",
})

function date(value: string | null): string {
  return value === null ? "Unavailable" : dateTime.format(new Date(value))
}

function toolCounts(events: ReviewEvent[]) {
  const outcomes = new Map<
    string,
    "succeeded" | "denied" | "failed" | "unknown"
  >()
  for (const event of events) {
    const id = event.payload?.invocationId
    if (typeof id !== "string") continue
    if (event.type === "tool_started") outcomes.set(id, "unknown")
    if (event.type !== "tool_finished") continue
    outcomes.set(
      id,
      event.payload?.outcome === "success"
        ? "succeeded"
        : event.payload?.status === 401 || event.payload?.status === 403
          ? "denied"
          : event.payload?.outcome === "failure"
            ? "failed"
            : "unknown"
    )
  }
  return [...outcomes.values()].reduce(
    (counts, value) => ({ ...counts, [value]: counts[value] + 1 }),
    { succeeded: 0, denied: 0, failed: 0, unknown: 0 }
  )
}

const scenarioNames = {
  success: "Default responses",
  unavailable: "Information unavailable",
  slow: "Slow response",
  failure: "Tool failure",
  custom: "Custom named sample overrides",
} as const

/** Shared factual review on the durable call page and the Practice deep link. */
export function CallReview({
  call,
  events,
  observations,
  embedded = false,
}: {
  call: WorkspaceCall
  events: ReviewEvent[]
  observations: Observation[]
  embedded?: boolean
}) {
  const counts = toolCounts(events)
  const evidence = call.evidence ?? {
    state: "unknown" as const,
    contiguousSeq: 0,
    finalSeq: null,
    producerLoss: false,
    truncated: false,
    integrityConflict: false,
    reconciled: false,
  }
  const assistantPath =
    call.assistantId === null
      ? null
      : `/assistants/${encodeURIComponent(call.assistantId)}`
  const canRepeat = assistantPath !== null && !call.assistantArchived
  const testAgain = canRepeat
    ? `${assistantPath}/sandbox?retest=${encodeURIComponent(call.id)}${call.scenario && call.scenario !== "custom" ? `&scenario=${call.scenario}` : ""}`
    : null

  return (
    <section aria-label="Call review" className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold">Review</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Factual call record and your own observations stay separate.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">What ran</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <span className="text-muted-foreground">Mode</span>
            <p>Practice · browser · sample data</p>
          </div>
          <div>
            <span className="text-muted-foreground">Configuration</span>
            <p>
              {call.configSource === "preview"
                ? "Unsaved preview"
                : call.configSource === "saved"
                  ? "Saved configuration"
                  : "Unavailable"}
              {call.baseAssistantRevision === null
                ? ""
                : ` · revision ${call.baseAssistantRevision}`}
            </p>
          </div>
          <div>
            <span className="text-muted-foreground">Scenario</span>
            <p>
              {call.scenario ? scenarioNames[call.scenario] : "Unavailable"}
              {call.scenarioHasOverrides && call.scenario !== "custom"
                ? " · named sample overrides"
                : ""}
            </p>
          </div>
          {embedded && (
            <div>
              <span className="text-muted-foreground">Started</span>
              <p>{date(call.startedAt)}</p>
            </div>
          )}
          <div>
            <span className="text-muted-foreground">Assistant ready</span>
            <p>{date(call.readyAt)}</p>
          </div>
          {embedded && (
            <div>
              <span className="text-muted-foreground">Duration</span>
              <p>
                {call.durationSecs === null
                  ? "Unavailable"
                  : `${call.durationSecs.toFixed(3)} seconds`}
              </p>
            </div>
          )}
          <div>
            <span className="text-muted-foreground">Lifecycle</span>
            <p>
              {call.state}
              {call.endedReason
                ? ` · ${call.endedReason.replaceAll("_", " ")}`
                : ""}
            </p>
          </div>
          <div>
            <span className="text-muted-foreground">Evidence</span>
            <p>
              {call.startedAt === null
                ? "No voice execution"
                : evidence?.state === "complete"
                  ? "Complete"
                  : evidence?.state === "partial"
                    ? "Partial"
                    : "Completeness unknown"}
            </p>
          </div>
          <div>
            <span className="text-muted-foreground">
              Reported tool outcomes
            </span>
            <p>
              {counts.succeeded} delivered · {counts.denied} denied ·{" "}
              {counts.failed} failed · {counts.unknown} unknown
            </p>
          </div>
        </CardContent>
      </Card>
      {call.startedAt !== null && evidence?.state !== "complete" && (
        <p className="rounded-md border border-orange-500/30 bg-orange-500/5 p-3 text-sm">
          The evidence record is{" "}
          {evidence?.state === "partial" ? "partial" : "not yet complete"}.
          Missing tool events remain unknown. A call ending does not prove its
          scenario succeeded.
        </p>
      )}
      <HistoricalSandboxTimeline
        events={events}
        evidence={evidence}
        reportingUntil={call.reportingUntil}
      />
      {call.startedAt !== null &&
        (["ended", "incomplete", "failed"].includes(call.state) ||
          observations.length > 0) && (
          <ObservationEditor
            callId={call.id}
            initialObservations={observations}
          />
        )}
      <div className="flex flex-wrap gap-2">
        {canRepeat && (
          <Button variant="outline" asChild>
            <Link href={`${assistantPath}#instructions`}>
              Edit instructions
            </Link>
          </Button>
        )}
        {testAgain && (
          <Button asChild>
            <Link href={testAgain}>Test again</Link>
          </Button>
        )}
        {embedded && (
          <Button variant="outline" asChild>
            <Link href={`/calls/${encodeURIComponent(call.id)}`}>
              View call
            </Link>
          </Button>
        )}
      </div>
      {testAgain && (
        <p className="text-sm text-muted-foreground">
          Test again opens the current Practice settings and does not start a
          call. Check sample overrides before starting; historical overrides are
          not restored.
        </p>
      )}
      {call.assistantArchived && (
        <p className="text-sm text-muted-foreground">
          Archived assistant. Historical evidence remains available; a new test
          cannot start.
        </p>
      )}
    </section>
  )
}
