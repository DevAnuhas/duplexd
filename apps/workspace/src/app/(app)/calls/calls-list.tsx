import Link from "next/link"

import { CopyButton } from "@/components/copy-button"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { WorkspaceCall } from "@/data/calls"
import { CallProvenance, WorkspaceCallStateBadge } from "./call-provenance"

const dateTime = new Intl.DateTimeFormat("en", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short",
})

function formatTimestamp(value: string | null): string {
  return value === null ? "Not reported" : dateTime.format(new Date(value))
}

function formatDuration(value: number | null): string {
  if (value === null) return "Not reported"
  if (value < 60) return `${value.toFixed(value < 10 ? 1 : 0)} sec`
  const minutes = Math.floor(value / 60)
  const seconds = Math.round(value % 60)
  return `${minutes} min ${seconds} sec`
}

function shortId(id: string): string {
  return id.length <= 16 ? id : `${id.slice(0, 8)}…${id.slice(-4)}`
}

export function CallsList({
  calls,
  nextCursor,
  basePath,
  assistantName,
}: {
  calls: WorkspaceCall[]
  nextCursor: string | null
  basePath: string
  assistantName?: string
}) {
  return (
    <div className="space-y-5">
      {calls.length === 0 ? (
        <div className="flex min-h-52 flex-col items-start justify-center border-y py-10">
          <h2 className="text-lg font-medium">No calls yet</h2>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">
            {assistantName
              ? `Calls with ${assistantName} will appear here.`
              : "Integration calls and Practice preparations appear here."}
          </p>
          <Button asChild className="mt-5 h-11">
            <Link
              href={
                assistantName
                  ? basePath.replace(/\/calls$/, "/sandbox")
                  : "/keys"
              }
            >
              {assistantName ? "Open Practice" : "View API keys"}
            </Link>
          </Button>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead>Started</TableHead>
                {assistantName === undefined && (
                  <TableHead>Assistant</TableHead>
                )}
                <TableHead>Source</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>API key</TableHead>
                <TableHead className="text-right">Call ID</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {calls.map((call) => (
                <TableRow key={call.id}>
                  <TableCell>
                    <Link
                      href={`/calls/${call.id}${assistantName ? `?from=${encodeURIComponent(basePath)}` : ""}`}
                      prefetch={true}
                      className="inline-flex min-h-11 items-center font-medium underline-offset-4 hover:underline"
                    >
                      {formatTimestamp(call.startedAt)}
                    </Link>
                  </TableCell>
                  {assistantName === undefined && (
                    <TableCell>{call.assistantName ?? "Unavailable"}</TableCell>
                  )}
                  <TableCell>
                    <CallProvenance call={call} />
                  </TableCell>
                  <TableCell>
                    <WorkspaceCallStateBadge call={call} />
                  </TableCell>
                  <TableCell>{formatDuration(call.durationSecs)}</TableCell>
                  <TableCell>
                    {call.apiKey === null ? (
                      call.source === "sandbox" ? (
                        "Workspace session"
                      ) : (
                        "Unavailable"
                      )
                    ) : (
                      <div>
                        <div>{call.apiKey.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {call.apiKey.prefix}…
                        </div>
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1 tabular-nums">
                      <span>{shortId(call.id)}</span>
                      <CopyButton
                        value={call.id}
                        label="Copy call ID"
                        successLabel="Call ID copied"
                        compact
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {nextCursor !== null && (
        <Button variant="outline" asChild className="h-11">
          <Link href={`${basePath}?cursor=${encodeURIComponent(nextCursor)}`}>
            Older calls
          </Link>
        </Button>
      )}
    </div>
  )
}
