import Link from 'next/link';
import { Suspense } from 'react';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { listCallsForAccount } from '@/data/calls';

import { CallStateBadge } from './calls/call-state-badge';
import { requireShell } from './shell-data';

/**
 * Overview.
 *
 * Four numbers and the five most recent calls — all of them queried, none of
 * them invented. There is deliberately no chart: `calls` has a duration but no
 * cost column, and a trend line over three points is worse than a number.
 *
 * `incomplete` gets a tile of its own rather than being folded into the total,
 * because it is the one number that means something is wrong. A tenant should
 * not have to open the call list to discover that agents have been dying.
 */
export default function OverviewPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
        <p className="text-muted-foreground">
          What this organization has running, and what has happened lately.
        </p>
      </div>

      <Suspense fallback={<StatsSkeleton />}>
        <Stats />
      </Suspense>

      <Suspense fallback={<Skeleton className="h-64 w-full" />}>
        <RecentActivity />
      </Suspense>
    </div>
  );
}

function StatTile({
  label,
  value,
  href,
  tone,
}: {
  label: string;
  value: number;
  href: string;
  tone?: 'warning';
}) {
  return (
    <Link href={href} className="block">
      <Card className="hover:border-foreground/20 h-full transition-colors">
        <CardHeader className="pb-2">
          <CardDescription>{label}</CardDescription>
        </CardHeader>
        <CardContent>
          <span
            className={
              tone === 'warning' && value > 0
                ? 'text-3xl font-semibold tabular-nums text-orange-600 dark:text-orange-400'
                : 'text-3xl font-semibold tabular-nums'
            }
          >
            {value}
          </span>
        </CardContent>
      </Card>
    </Link>
  );
}

function StatsSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {[0, 1, 2, 3].map((index) => (
        <Skeleton key={index} className="h-28 w-full" />
      ))}
    </div>
  );
}

async function Stats() {
  const { counts } = await requireShell();

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatTile label="Assistants" value={counts.assistants} href="/assistants" />
      <StatTile label="API keys" value={counts.apiKeys} href="/keys" />
      <StatTile label="Calls" value={counts.calls} href="/calls" />
      <StatTile
        label="Incomplete"
        value={counts.incompleteCalls}
        href="/calls"
        tone="warning"
      />
    </div>
  );
}

/** `21:06 · 20 Sep` — the time first, because that is what is being scanned. */
function when(value: string): string {
  const date = new Date(value);

  return `${new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)} · ${new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
  }).format(date)}`;
}

function duration(value: number | null): string {
  return value === null ? 'Not reported' : `${Math.round(value)}s`;
}

async function RecentActivity() {
  const { account, counts } = await requireShell();

  /**
   * No assistants means no calls can exist — there is nothing to have called.
   * Saying "no calls yet" there would be true and useless; the tenant's actual
   * next action is to create one.
   */
  if (counts.assistants === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Nothing here yet</EmptyTitle>
          <EmptyDescription>
            Create an assistant, then mint an API key to start calls from your
            app.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button asChild>
            <Link href="/assistants/new">Create an assistant</Link>
          </Button>
        </EmptyContent>
      </Empty>
    );
  }

  const result = await listCallsForAccount(account.id, { limit: 5 });

  if (result.kind !== 'ok') {
    throw new Error('The overview passes no cursor, so it cannot be invalid.');
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle>Recent calls</CardTitle>
          <CardDescription>The five most recent.</CardDescription>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href="/calls">All calls</Link>
        </Button>
      </CardHeader>
      <CardContent>
        {result.calls.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No calls yet. Mint an API key and start one from your app — they
            appear here as they happen.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Started</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Duration</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.calls.map((call) => (
                <TableRow key={call.id}>
                  <TableCell>
                    <Link
                      href={`/calls/${call.id}`}
                      prefetch
                      className="underline-offset-4 hover:underline"
                    >
                      {when(call.startedAt ?? call.createdAt)}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <CallStateBadge state={call.state} />
                  </TableCell>
                  <TableCell className="text-muted-foreground tabular-nums">
                    {duration(call.durationSecs)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
