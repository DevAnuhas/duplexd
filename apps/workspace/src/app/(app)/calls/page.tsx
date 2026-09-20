import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';

import { CopyButton } from '@/components/copy-button';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { listWorkspaceCallsForAccount } from '@/data/calls';
import { requireShell } from '../shell-data';
import { CallStateBadge } from './call-state-badge';

const dateTime = new Intl.DateTimeFormat('en', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'UTC',
  timeZoneName: 'short',
});

function formatTimestamp(value: string | null): string {
  return value === null ? 'Not reported' : dateTime.format(new Date(value));
}

function formatDuration(value: number | null): string {
  if (value === null) {
    return 'Not reported';
  }
  if (value < 60) {
    return `${value.toFixed(value < 10 ? 1 : 0)} sec`;
  }

  const minutes = Math.floor(value / 60);
  const seconds = Math.round(value % 60);
  return `${minutes} min ${seconds} sec`;
}

function shortId(id: string): string {
  return id.length <= 16 ? id : `${id.slice(0, 8)}…${id.slice(-4)}`;
}

async function CallsContent({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string | string[] }>;
}) {
  const { account } = await requireShell();

  const value = (await searchParams).cursor;
  const cursor = typeof value === 'string' ? value : null;
  const result = await listWorkspaceCallsForAccount(account.id, {
    cursor,
  });

  if (result.kind === 'invalid_cursor') {
    redirect('/calls');
  }

  return (
    <>
      {result.calls.length === 0 ? (
        <div className="flex min-h-52 flex-col items-start justify-center border-y py-10">
          <h2 className="text-lg font-medium">No calls yet</h2>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">
            Calls started through the API appear here.
          </p>
          <Button asChild className="mt-5 h-11">
            <Link href="/keys">View API keys</Link>
          </Button>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead>Started</TableHead>
                <TableHead>Assistant</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>API key</TableHead>
                <TableHead className="text-right">Call ID</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.calls.map((call) => (
                <TableRow key={call.id}>
                  <TableCell>
                    <Link
                      href={`/calls/${call.id}`}
                      prefetch={true}
                      className="inline-flex min-h-11 items-center font-medium underline-offset-4 hover:underline"
                    >
                      {formatTimestamp(call.startedAt)}
                    </Link>
                  </TableCell>
                  <TableCell>{call.assistantName ?? 'Unavailable'}</TableCell>
                  <TableCell>
                    <CallStateBadge state={call.state} />
                  </TableCell>
                  <TableCell>{formatDuration(call.durationSecs)}</TableCell>
                  <TableCell>
                    {call.apiKey === null ? (
                      'Unavailable'
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

      {result.nextCursor !== null && (
        <Button variant="outline" asChild className="h-11">
          <Link href={`/calls?cursor=${encodeURIComponent(result.nextCursor)}`}>
            Older calls
          </Link>
        </Button>
      )}
    </>
  );
}

function CallsSkeleton() {
  return (
    <div className="overflow-hidden rounded-lg border p-4" aria-label="Loading calls">
      <div className="space-y-4">
        {Array.from({ length: 5 }, (_, index) => (
          <div key={index} className="grid grid-cols-3 gap-4 sm:grid-cols-6">
            {Array.from({ length: 6 }, (_, cell) => (
              <Skeleton key={cell} className="h-5 w-full" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function CallsPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string | string[] }>;
}) {
  return (
    <main className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Calls</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Inspect call outcomes, transcripts, and tool activity.
        </p>
      </header>
      <Suspense fallback={<CallsSkeleton />}>
        <CallsContent searchParams={searchParams} />
      </Suspense>
    </main>
  );
}
