import Link from 'next/link';

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

type Counts = {
  assistants: number;
  apiKeys: number;
  calls: number;
  incompleteCalls: number;
};

export const dynamic = 'force-dynamic';

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
 *
 * **Awaited, not streamed.** The stat tiles are links and the empty state
 * holds the "Create an assistant" button; behind a Suspense boundary those
 * rendered correctly and never hydrated, working only as full-page anchors.
 * This was the last page in the app still streaming its session content.
 */
export default async function OverviewPage() {
  const { account, counts } = await requireShell();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
        <p className="text-muted-foreground">
          What this organization has running, and what has happened lately.
        </p>
      </div>

      <Stats counts={counts} />
      <RecentActivity accountId={account.id} assistantCount={counts.assistants} />
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

function Stats({ counts }: { counts: Counts }) {
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

/**
 * `21:06 · 20 Sep` — the time first, because that is what is being scanned.
 *
 * **Null means null.** A call that never started has no start time, and
 * falling back to `createdAt` would print a plausible one — which reads as
 * "this call ran at 21:44" for a call that never connected. The calls list
 * says "Not reported" for exactly this row, and two pages disagreeing about
 * the same call is worse than either answer alone.
 */
function when(value: string | null): string {
  if (value === null) {
    return 'Not reported';
  }

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

async function RecentActivity({
  accountId,
  assistantCount,
}: {
  accountId: string;
  assistantCount: number;
}) {
  /**
   * No assistants means no calls can exist — there is nothing to have called.
   * Saying "no calls yet" there would be true and useless; the tenant's actual
   * next action is to create one.
   */
  if (assistantCount === 0) {
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

  const result = await listCallsForAccount(accountId, { limit: 5 });

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
                      {when(call.startedAt)}
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
