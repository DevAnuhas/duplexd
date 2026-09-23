import { ArrowUpRight, Plus } from "@phosphor-icons/react/ssr"
import Link from "next/link"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
} from "@/components/ui/empty"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { listAssistantsForAccount } from "@/data/assistants"
import { validateRunnableAssistant } from "@/practice/configuration"
import { requireShell } from "../shell-data"
import { ArchiveButton } from "./archive-button"

export const dynamic = "force-dynamic"

const updatedFormat = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
})

export default async function AssistantsPage() {
  const { account } = await requireShell()
  const assistants = await listAssistantsForAccount(account.id)
  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Assistants</h1>
          <p className="mt-2 text-muted-foreground">
            The voices and instructions behind your calls.
          </p>
        </div>
        <Button asChild className="min-h-11">
          <Link href="/assistants/new">
            <Plus
              weight="regular"
              className="size-4"
              data-icon="inline-start"
              aria-hidden="true"
            />{" "}
            Create assistant
          </Link>
        </Button>
      </header>

      <AssistantList assistants={assistants} />
    </div>
  )
}

function AssistantList({
  assistants,
}: {
  assistants: Awaited<ReturnType<typeof listAssistantsForAccount>>
}) {
  return (
    <>
      {assistants.length === 0 ? (
        <Empty className="rounded-lg shadow-none">
          <EmptyHeader className="pt-4">
            <EmptyTitle className="text-xl">
              Your first assistant starts here
            </EmptyTitle>
            <EmptyDescription className="max-w-lg text-base leading-relaxed">
              Start with your own instructions or a fictional sample. Then use
              Practice to try a conversation with sample tool responses.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent className="flex flex-wrap gap-3 pb-4">
            <Button asChild className="min-h-11">
              <Link href="/assistants/new">
                <Plus
                  weight="regular"
                  className="size-4"
                  data-icon="inline-start"
                  aria-hidden="true"
                />{" "}
                Create assistant
              </Link>
            </Button>
            <Button asChild variant="outline" className="min-h-11">
              <Link href="/assistants/new?template=riley">
                Riley sample{" "}
                <ArrowUpRight
                  weight="regular"
                  className="size-4"
                  data-icon="inline-end"
                  aria-hidden="true"
                />
              </Link>
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">Name</TableHead>
                <TableHead>Voice</TableHead>
                <TableHead>Updated (UTC)</TableHead>
                <TableHead className="pr-5 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {assistants.map((assistant) => (
                <TableRow key={assistant.id}>
                  <TableCell className="max-w-72 py-5 pl-5 font-medium">
                    <Link
                      className="block break-words whitespace-normal underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
                      href={`/assistants/${assistant.id}`}
                      prefetch={true}
                    >
                      {assistant.name}
                    </Link>
                    {validateRunnableAssistant(assistant, "practice").length >
                      0 && (
                      <Badge variant="outline" className="mt-2 font-normal">
                        Needs setup before testing
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="max-w-44 break-words whitespace-normal text-muted-foreground">
                    {assistant.voice || "Not configured"}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground tabular-nums">
                    <time dateTime={assistant.updatedAt.toISOString()}>
                      {updatedFormat.format(assistant.updatedAt)}
                    </time>
                  </TableCell>
                  <TableCell className="pr-5">
                    <div className="flex items-center justify-end gap-1">
                      <Button asChild variant="ghost" className="min-h-11">
                        <Link
                          href={`/assistants/${assistant.id}`}
                          prefetch={true}
                          aria-label={`Open ${assistant.name}`}
                        >
                          Open{" "}
                          <ArrowUpRight
                            weight="regular"
                            className="size-4"
                            data-icon="inline-end"
                            aria-hidden="true"
                          />
                        </Link>
                      </Button>
                      <Button asChild variant="ghost" className="min-h-11">
                        <Link
                          href={`/assistants/${assistant.id}/sandbox`}
                          aria-label={`Practice with ${assistant.name}`}
                        >
                          Practice
                        </Link>
                      </Button>
                      <ArchiveButton
                        assistantId={assistant.id}
                        assistantName={assistant.name}
                        assistantRevision={assistant.revision}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  )
}
