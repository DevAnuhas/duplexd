import { redirect } from "next/navigation"

import { listWorkspaceCallsForAccount } from "@/data/calls"
import { requireShell } from "../shell-data"
import { CallsList } from "./calls-list"

export const dynamic = "force-dynamic"

export default async function CallsPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string | string[] }>
}) {
  const { account } = await requireShell()
  const value = (await searchParams).cursor
  const cursor = typeof value === "string" ? value : null
  const result = await listWorkspaceCallsForAccount(account.id, { cursor })
  if (result.kind === "invalid_cursor") redirect("/calls")

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Calls</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Inspect call outcomes, transcripts, and tool activity.
        </p>
      </header>
      <CallsList
        calls={result.calls}
        nextCursor={result.nextCursor}
        basePath="/calls"
      />
    </div>
  )
}
