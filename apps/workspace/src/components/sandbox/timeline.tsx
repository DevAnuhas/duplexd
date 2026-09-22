"use client"

import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  SandboxTimelineController,
  type TimelineState,
} from "@/sandbox/client/timeline"

function describe(event: TimelineState["events"][number]) {
  const payload = event.payload ?? {}
  if (event.type === "transcript_user" || event.type === "transcript_assistant")
    return {
      label: event.type === "transcript_user" ? "You" : "Assistant",
      text:
        typeof payload.text === "string"
          ? payload.text
          : "Transcript text not reported.",
    }
  if (event.type === "tool_started" || event.type === "tool_finished") {
    const tool = typeof payload.tool === "string" ? payload.tool : "Tool"
    const outcome =
      event.type === "tool_started"
        ? "started"
        : payload.outcome === "success"
          ? "delivery succeeded"
          : payload.outcome === "failure"
            ? "delivery failed"
            : "outcome not reported"
    const duration =
      typeof payload.durationMs === "number" && payload.durationMs >= 0
        ? ` · ${payload.durationMs} ms`
        : ""
    const scenario = ["success", "slow", "failure"].includes(
      String(payload.practiceScenario)
    )
      ? ` · ${payload.practiceScenario} scenario`
      : ""
    const selection =
      typeof payload.practiceSelectedStatus === "number" &&
      Number.isInteger(payload.practiceSelectedStatus) &&
      payload.practiceSelectedStatus >= 100 &&
      payload.practiceSelectedStatus <= 599
        ? ` · selected sample HTTP ${payload.practiceSelectedStatus}`
        : ""
    return {
      label: "Practice · sample data",
      text: `${tool}: ${outcome}${duration}${scenario}${selection}. Sample selection is not business success.`,
    }
  }
  const labels: Record<string, string> = {
    agent_ready: "Agent readiness persisted",
    bot_speech_started: "Assistant started speaking",
    bot_speech_stopped: "Assistant stopped speaking",
    interruption: "Speech interrupted",
    delegation_created: "Tool delegation created",
    stop_requested: "Stop requested",
  }
  return {
    label: event.namespace === "platform" ? "Platform" : "Agent",
    text: labels[event.type] ?? "Activity recorded",
  }
}

/** Shared safe renderer: consumes already-projected evidence, never raw payload dumps. */
export function SandboxTimeline({
  state,
  onRefresh,
}: {
  state: TimelineState
  onRefresh: () => void
}) {
  const viewport = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const [away, setAway] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => {
    if (pinned.current && viewport.current)
      viewport.current.scrollTop = viewport.current.scrollHeight
  }, [state.events])
  const evidence = state.evidence
  return (
    <section
      aria-label="Call timeline"
      className="min-w-0 space-y-4 rounded-lg border p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-semibold">Call timeline</h2>
        <Badge variant="secondary">
          Evidence {evidence?.state ?? "unknown"}
        </Badge>
      </div>
      <p className="text-sm text-muted-foreground">
        Persisted events only. Evidence completeness describes received events,
        not everything that was said or a confirmed call ending.
      </p>
      <p role="status" aria-live="polite" className="text-sm">
        {state.events.length} events loaded{state.loading ? " · Updating…" : ""}
        {state.hasMore && !state.limited ? " · More events pending" : ""}.
      </p>
      {state.updatedAt !== null && (
        <p className="text-xs text-muted-foreground">
          Last update {Math.max(0, Math.floor((now - state.updatedAt) / 1000))}{" "}
          seconds ago
          {now - state.updatedAt > 10_000 && evidence?.state !== "complete"
            ? " · Updates delayed"
            : ""}
          .
        </p>
      )}
      {state.error && (
        <p role="alert" className="text-sm">
          {state.error}
        </p>
      )}
      {(state.limited ||
        evidence?.truncated ||
        evidence?.producerLoss ||
        evidence?.integrityConflict ||
        evidence?.reconciled) && (
        <p className="rounded-md border p-3 text-sm">
          {state.limited
            ? "Display limit reached. Only the loaded events are shown. "
            : ""}
          {evidence?.producerLoss || evidence?.truncated
            ? "Some evidence was lost or truncated. "
            : ""}
          {evidence?.integrityConflict
            ? "Conflicting evidence was reported. "
            : ""}
          {evidence?.reconciled
            ? "Evidence was reconciled without claiming an agent-confirmed ending."
            : ""}
        </p>
      )}
      <div
        ref={viewport}
        tabIndex={0}
        aria-label="Timeline events"
        className="max-h-96 overflow-y-auto rounded-md border focus-visible:outline-2 focus-visible:outline-ring"
        onScroll={() => {
          const node = viewport.current
          if (!node) return
          pinned.current =
            node.scrollHeight - node.scrollTop - node.clientHeight < 48
          setAway(!pinned.current)
        }}
      >
        {state.events.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            No persisted events yet. Preparing a test does not start voice or
            generate a transcript.
          </p>
        ) : (
          <ol className="divide-y">
            {state.events.map((event) => {
              const content = describe(event)
              return (
                <li
                  key={`${event.namespace}:${event.seq}`}
                  className="space-y-1 p-4 text-sm [overflow-wrap:anywhere] break-words"
                >
                  <div className="flex flex-wrap justify-between gap-2">
                    <span className="font-medium">{content.label}</span>
                    <time
                      dateTime={event.at}
                      className="text-xs text-muted-foreground"
                    >
                      {new Date(event.at).toLocaleTimeString()}
                    </time>
                  </div>
                  <p className="whitespace-pre-wrap">{content.text}</p>
                </li>
              )
            })}
          </ol>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {away && (
          <Button
            variant="outline"
            className="min-h-11"
            onClick={() => {
              pinned.current = true
              setAway(false)
              if (viewport.current)
                viewport.current.scrollTop = viewport.current.scrollHeight
            }}
          >
            Jump to latest
          </Button>
        )}
        <Button
          variant="ghost"
          className="min-h-11"
          disabled={state.loading || state.limited}
          onClick={onRefresh}
        >
          Refresh evidence
        </Button>
      </div>
    </section>
  )
}
export function LiveSandboxTimeline({ callId }: { callId: string }) {
  // Caller keys by callId; do not mix evidence between calls.
  const [controller] = useState(() => new SandboxTimelineController(callId))
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot
  )
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async () => {
      if (timer) clearTimeout(timer)
      if (!document.hidden) await controller.refresh()
      const current = controller.getSnapshot()
      if (
        active &&
        !current.limited &&
        !(
          !current.hasMore &&
          current.evidence?.state === "complete" &&
          current.evidence.finalSeq !== null
        )
      )
        timer = setTimeout(
          () => {
            void refresh()
          },
          current.error ? 10_000 : 3000
        )
    }
    const visible = () => {
      if (!document.hidden) void refresh()
    }
    void refresh()
    document.addEventListener("visibilitychange", visible)
    return () => {
      active = false
      if (timer) clearTimeout(timer)
      controller.pause()
      document.removeEventListener("visibilitychange", visible)
    }
  }, [controller])
  return (
    <SandboxTimeline
      state={state}
      onRefresh={() => {
        void controller.refresh()
      }}
    />
  )
}
