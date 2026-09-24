"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"

import { SandboxTimeline } from "@/components/sandbox/timeline"
import type { ReviewEvent } from "@/data/calls"
import { SANDBOX_LIMITS, type SandboxEventPage } from "@/sandbox/protocol"
import type { TimelineState } from "@/sandbox/client/timeline"

/** Historical review uses a pure server read; live event polling advances execution. */
export function HistoricalSandboxTimeline({
  events,
  evidence,
  reportingUntil,
}: {
  events: ReviewEvent[]
  evidence: SandboxEventPage["evidence"]
  reportingUntil: string | null
}) {
  const router = useRouter()
  useEffect(() => {
    if (
      evidence.state === "complete" ||
      reportingUntil === null ||
      Date.now() >= Date.parse(reportingUntil)
    )
      return
    const timer = setInterval(() => {
      if (!document.hidden && Date.now() < Date.parse(reportingUntil))
        router.refresh()
    }, SANDBOX_LIMITS.pollIntervalMs)
    return () => clearInterval(timer)
  }, [evidence.state, reportingUntil, router])

  const shown = events.slice(0, 2000)
  const state: TimelineState = {
    events: shown.map((event) => ({ ...event, cursor: "" })),
    evidence,
    loading: false,
    error: null,
    limited: shown.length !== events.length,
    hasMore: false,
    updatedAt: null,
  }
  return <SandboxTimeline state={state} onRefresh={() => router.refresh()} />
}
