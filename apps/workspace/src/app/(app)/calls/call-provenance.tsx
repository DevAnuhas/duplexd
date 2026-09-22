import { Badge } from "@/components/ui/badge"
import type { WorkspaceCall } from "@/data/calls"
import { CallStateBadge } from "./call-state-badge"

type CallIdentity = Pick<
  WorkspaceCall,
  "source" | "testMode" | "state" | "endedReason"
>

/** Absence of startedAt alone is not proof that dispatch never happened. */
export function preparationLabel(call: CallIdentity): string | null {
  if (call.source !== "sandbox") return null
  if (call.state === "reserved") return "Prepared · voice not started"
  if (
    call.state === "failed" &&
    call.endedReason === "canceled_before_dispatch"
  )
    return "Preparation canceled"
  if (call.state === "failed" && call.endedReason === "reservation_expired")
    return "Preparation expired"
  return null
}

export function CallProvenance({
  call,
}: {
  call: Pick<WorkspaceCall, "source" | "testMode">
}) {
  return (
    <Badge variant="secondary">
      {call.source === "sandbox"
        ? call.testMode === "practice"
          ? "Practice · sample data"
          : "Sandbox"
        : "Integration"}
    </Badge>
  )
}

export function WorkspaceCallStateBadge({ call }: { call: CallIdentity }) {
  const preparation = preparationLabel(call)
  return preparation === null ? (
    <CallStateBadge state={call.state} />
  ) : (
    <Badge variant="outline">{preparation}</Badge>
  )
}
