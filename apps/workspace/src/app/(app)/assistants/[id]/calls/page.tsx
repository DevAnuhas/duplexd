import { notFound, redirect } from "next/navigation"

import { CallsList } from "@/app/(app)/calls/calls-list"
import { getAssistantForAccount } from "@/data/assistants"
import { listWorkspaceCallsForAccount } from "@/data/calls"
import { parseCallListFilters } from "@/data/call-list-filters"
import { requireShell } from "../../../shell-data"
import { AssistantNavigation } from "../../assistant-navigation"

export const dynamic = "force-dynamic"

export default async function AssistantCallsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{
    cursor?: string | string[]
    source?: string | string[]
    mode?: string | string[]
  }>
}) {
  const { account } = await requireShell()
  const { id } = await params
  const assistant = await getAssistantForAccount(account.id, id)
  if (assistant === null) notFound()
  const basePath = `/assistants/${encodeURIComponent(id)}/calls`
  const filters = parseCallListFilters(await searchParams)
  if (filters === null) redirect(basePath)
  const result = await listWorkspaceCallsForAccount(account.id, {
    assistantId: id,
    ...filters,
  })
  if (result.kind === "invalid_cursor") redirect(basePath)

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <p className="text-sm text-muted-foreground">{assistant.name}</p>
        <h1 className="text-3xl font-semibold tracking-tight">Calls</h1>
        <p className="text-sm text-muted-foreground">
          History for this assistant, including Practice calls.
        </p>
      </header>
      <AssistantNavigation assistantId={id} active="calls" />
      <CallsList
        calls={result.calls}
        nextCursor={result.nextCursor}
        basePath={basePath}
        assistantName={assistant.name}
        source={filters.source}
        mode={filters.mode}
      />
    </div>
  )
}
