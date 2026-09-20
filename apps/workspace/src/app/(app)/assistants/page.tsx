import { Suspense } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { ArrowUpRight, Plus } from '@phosphor-icons/react/ssr';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
} from '@/components/ui/empty';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { listAssistantsForAccount } from '@/data/assistants';
import { requireShell } from '../shell-data';
import { ArchiveButton } from './archive-button';

const updatedFormat = new Intl.DateTimeFormat('en', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
});

export default async function AssistantsPage() {
  const { account } = await requireShell();
  const assistants = await listAssistantsForAccount(account.id);
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
            />{' '}
            Create assistant
          </Link>
        </Button>
      </header>

      <Suspense fallback={<Skeleton className="h-64 w-full rounded-lg" />}>
        <AssistantList />
      </Suspense>
    </div>
  );
}

async function AssistantList() {
  const { account } = await requireShell();
  const assistants = await listAssistantsForAccount(account.id);

  return (
    <>
      {assistants.length === 0 ? (
        <Empty className="rounded-lg shadow-none">
          <EmptyHeader className="pt-4">
            <EmptyTitle className="text-xl">
              Your first assistant starts here
            </EmptyTitle>
            <EmptyDescription className="max-w-lg text-base leading-relaxed">
              Give your assistant a voice, instructions, and a connection to
              your backend. Then mint an API key to start calls from your app.
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
                />{' '}
                Create assistant
              </Link>
            </Button>
            <Button asChild variant="outline" className="min-h-11">
              <Link href="/keys">
                API keys{' '}
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
                  </TableCell>
                  <TableCell className="max-w-44 break-words whitespace-normal text-muted-foreground">
                    {assistant.voice || 'Not configured'}
                  </TableCell>
                  <TableCell className="text-sm tabular-nums text-muted-foreground">
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
                          Open{' '}
                          <ArrowUpRight
                            weight="regular"
                            className="size-4"
                            data-icon="inline-end"
                            aria-hidden="true"
                          />
                        </Link>
                      </Button>
                      <ArchiveButton
                        assistantId={assistant.id}
                        assistantName={assistant.name}
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
  );
}
