import { notFound } from "next/navigation"
import Link from "next/link"

import { getAssistantForAccount } from "@/data/assistants"
import { getWorkspaceCallForAccount } from "@/data/calls"
import { CallReview } from "@/components/calls/call-review"
import { getCallObservationsForAccount } from "@/data/observations"
import { Button } from "@/components/ui/button"
import { requireShell } from "../../../shell-data"
import { Sandbox } from "./sandbox"

export const dynamic = "force-dynamic"

export default async function SandboxPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{
    review?: string | string[]
    retest?: string | string[]
    scenario?: string | string[]
  }>
}) {
  const { account, userId } = await requireShell()
  const { id } = await params
  const assistant = await getAssistantForAccount(account.id, id)
  if (assistant === null) notFound()
  const query = await searchParams
  const scopedId = (value: string | string[] | undefined) =>
    typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value)
      ? value
      : null
  const reviewId = scopedId(query.review)
  const retestId = scopedId(query.retest)
  const history =
    reviewId === null && retestId === null
      ? null
      : await getWorkspaceCallForAccount(account.id, reviewId ?? retestId!)
  const scopedCall =
    history?.call.source === "sandbox" && history.call.assistantId === id
      ? history
      : null
  const reviewedCall = reviewId !== null ? scopedCall : null
  const retestCall = retestId !== null ? scopedCall : null
  const observations = reviewedCall
    ? await getCallObservationsForAccount(
        account.id,
        reviewedCall.call.id,
        userId
      )
    : null
  const initialScenario =
    query.scenario === "success" ||
    query.scenario === "unavailable" ||
    query.scenario === "slow" ||
    query.scenario === "failure"
      ? query.scenario
      : undefined

  if (reviewedCall) {
    return (
      <div className="space-y-6">
        <Button asChild variant="ghost">
          <Link href={`/assistants/${encodeURIComponent(id)}/sandbox`}>
            Back to Practice
          </Link>
        </Button>
        <CallReview
          call={reviewedCall.call}
          events={reviewedCall.reviewEvents}
          observations={observations ?? []}
          embedded
        />
      </div>
    )
  }

  return (
    <div className="space-y-10">
      <Sandbox
        initialScenario={initialScenario}
        retestFromHistory={retestCall !== null}
        retestFromPreview={retestCall?.call.configSource === "preview"}
        assistant={{
          id,
          name: assistant.name,
          revision: assistant.revision,
          voice: assistant.voice,
          backendModel: assistant.backendModel,
        }}
      />
    </div>
  )
}
