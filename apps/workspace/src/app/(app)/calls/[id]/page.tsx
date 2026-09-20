import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AlertTriangle, ArrowLeft, ChevronDown } from 'lucide-react';
import { Suspense } from 'react';

import { CallStateBadge } from '../call-state-badge';
import { CopyButton } from '@/components/copy-button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Skeleton } from '@/components/ui/skeleton';
import {
  getWorkspaceCallForAccount,
  type WorkspaceCallEvent,
} from '@/data/calls';
import { requireShell } from '../../shell-data';

const dateTime = new Intl.DateTimeFormat('en', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
  timeZone: 'UTC',
  timeZoneName: 'short',
});

function timestamp(value: string | null): string {
  return value === null ? 'Not reported' : dateTime.format(new Date(value));
}

function duration(value: number | null): string {
  return value === null ? 'Not reported' : `${value.toFixed(3)} sec`;
}

type TranscriptEvent = WorkspaceCallEvent & {
  type: 'transcript_user' | 'transcript_assistant';
  payload: { text: string };
};

type ToolStartedEvent = WorkspaceCallEvent & {
  type: 'tool_started';
  payload: { tool: string; invocationId: string };
};

type ToolFinishedEvent = WorkspaceCallEvent & {
  type: 'tool_finished';
  payload: {
    tool: string;
    invocationId: string;
    outcome: 'success' | 'failure';
    durationMs: number;
    status?: number;
    errorCategory?: string;
  };
};

function isTranscript(event: WorkspaceCallEvent): event is TranscriptEvent {
  return (
    (event.type === 'transcript_user' ||
      event.type === 'transcript_assistant') &&
    event.payload !== undefined &&
    'text' in event.payload
  );
}

function isToolStarted(event: WorkspaceCallEvent): event is ToolStartedEvent {
  return (
    event.type === 'tool_started' &&
    event.payload !== undefined &&
    'invocationId' in event.payload &&
    !('outcome' in event.payload)
  );
}

function isToolFinished(event: WorkspaceCallEvent): event is ToolFinishedEvent {
  return (
    event.type === 'tool_finished' &&
    event.payload !== undefined &&
    'outcome' in event.payload
  );
}

type TimelineItem =
  | { kind: 'transcript'; event: TranscriptEvent }
  | {
      kind: 'tool';
      event: ToolStartedEvent;
      finish?: ToolFinishedEvent;
    };

function arrangeEvents(events: WorkspaceCallEvent[]): {
  timeline: TimelineItem[];
  technical: WorkspaceCallEvent[];
} {
  const timeline: TimelineItem[] = [];
  const technical: WorkspaceCallEvent[] = [];
  const tools = new Map<string, Extract<TimelineItem, { kind: 'tool' }>>();

  for (const event of events) {
    if (isTranscript(event)) {
      timeline.push({ kind: 'transcript', event });
      continue;
    }
    if (isToolStarted(event)) {
      if (tools.has(event.payload.invocationId)) {
        technical.push(event);
        continue;
      }
      const item: Extract<TimelineItem, { kind: 'tool' }> = {
        kind: 'tool',
        event,
      };
      tools.set(event.payload.invocationId, item);
      timeline.push(item);
      continue;
    }
    if (isToolFinished(event)) {
      const start = tools.get(event.payload.invocationId);
      if (start !== undefined && start.finish === undefined) {
        start.finish = event;
      } else {
        technical.push(event);
      }
      continue;
    }
    technical.push(event);
  }

  return { timeline, technical };
}

function technicalLabel(type: string): string {
  return type.replaceAll('_', ' ');
}

async function CallDetailContent({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { account } = await requireShell();

  const { id } = await params;
  const result = await getWorkspaceCallForAccount(account.id, id);

  if (result === null) {
    notFound();
  }

  const { timeline, technical } = arrangeEvents(result.events);
  const endingLabel = result.call.state === 'incomplete' ? 'Detected' : 'Ended';

  return (
    <>
      <div className="flex items-center gap-1 text-sm text-muted-foreground tabular-nums">
        <span className="break-all">{result.call.id}</span>
        <CopyButton
          value={result.call.id}
          label="Copy call ID"
          successLabel="Call ID copied"
          compact
        />
      </div>

      {result.call.state === 'incomplete' && (
        <Alert className="border-orange-500/30 bg-orange-500/5">
          <AlertTriangle aria-hidden="true" />
          <AlertTitle>Call incomplete</AlertTitle>
          <AlertDescription>
            Agent stopped reporting. A completed ending was not received.
            Duration is the last reported value.
          </AlertDescription>
        </Alert>
      )}

      <dl className="grid overflow-hidden rounded-lg border sm:grid-cols-2 lg:grid-cols-3">
        <div className="border-b p-4 sm:border-r">
          <dt className="text-xs text-muted-foreground">State</dt>
          <dd className="mt-2">
            <CallStateBadge state={result.call.state} />
          </dd>
        </div>
        <div className="border-b p-4 lg:border-r">
          <dt className="text-xs text-muted-foreground">Assistant</dt>
          <dd className="mt-1 font-medium">
            {result.call.assistantName ?? 'Unavailable'}
          </dd>
        </div>
        <div className="border-b p-4 sm:border-r lg:border-r-0">
          <dt className="text-xs text-muted-foreground">Started</dt>
          <dd className="mt-1 font-medium">
            {timestamp(result.call.startedAt)}
          </dd>
        </div>
        <div className="border-b p-4 lg:border-b-0 lg:border-r">
          <dt className="text-xs text-muted-foreground">Duration</dt>
          <dd className="mt-1 font-medium">
            {duration(result.call.durationSecs)}
          </dd>
        </div>
        <div className="border-b p-4 sm:border-b-0 sm:border-r">
          <dt className="text-xs text-muted-foreground">End reason</dt>
          <dd className="mt-1 font-medium capitalize">
            {result.call.endedReason?.replaceAll('_', ' ') ?? 'Not reported'}
          </dd>
        </div>
        <div className="p-4">
          <dt className="text-xs text-muted-foreground">{endingLabel}</dt>
          <dd className="mt-1 font-medium">
            {timestamp(result.call.endedAt)}
          </dd>
        </div>
      </dl>

      <section aria-labelledby="timeline-heading" className="space-y-5">
        <div>
          <h2 id="timeline-heading" className="text-lg font-semibold">
            Timeline
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Transcript and tool activity in reporting order.
          </p>
        </div>

        {timeline.length === 0 && (
          <div className="border-y py-8 text-sm text-muted-foreground">
            No transcript or tool events were recorded.
          </div>
        )}

        {timeline.length > 0 && (
          <ol className="relative space-y-4 border-l pl-6">
            {timeline.map((item) => {
              if (item.kind === 'transcript') {
                const caller = item.event.type === 'transcript_user';
                return (
                  <li key={item.event.seq} className="relative">
                    <span className="absolute top-5 -left-[1.85rem] size-2 rounded-full bg-border" />
                    <div
                      className={
                        caller
                          ? 'mr-8 rounded-lg border bg-muted/35 p-4 sm:mr-20'
                          : 'ml-8 rounded-lg border bg-card p-4 sm:ml-20'
                      }
                    >
                      <div className="flex items-center justify-between gap-4">
                        <p className="text-sm font-medium">
                          {caller ? 'Caller' : 'Assistant'}
                        </p>
                        <time className="shrink-0 text-xs text-muted-foreground">
                          {timestamp(item.event.at)}
                        </time>
                      </div>
                      <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed">
                        {item.event.payload.text}
                      </p>
                    </div>
                  </li>
                );
              }

              const finish = item.finish?.payload;
              const status =
                finish === undefined
                  ? 'No result recorded.'
                  : finish.outcome === 'success'
                    ? `completed · ${Math.round(finish.durationMs)} ms`
                    : `failed · ${finish.errorCategory ?? 'Failed'} · ${Math.round(finish.durationMs)} ms`;

              return (
                <li key={item.event.seq} className="relative">
                  <span className="absolute top-5 -left-[1.85rem] size-2 rounded-full bg-primary" />
                  <Card className="gap-0 py-0 shadow-none">
                    <CardContent className="flex items-center justify-between gap-4 px-4 py-4">
                      <p className="text-sm">
                        <span className="font-medium">
                          {item.event.payload.tool}
                        </span>{' '}
                        <span className="text-muted-foreground">— {status}</span>
                      </p>
                      <time className="shrink-0 text-xs text-muted-foreground">
                        {timestamp(item.event.at)}
                      </time>
                    </CardContent>
                  </Card>
                </li>
              );
            })}
          </ol>
        )}

        {technical.length > 0 && (
          <Collapsible className="group rounded-lg border">
            <CollapsibleTrigger asChild>
              <Button
                variant="ghost"
                className="h-auto w-full justify-between rounded-lg px-4 py-3"
              >
                Technical events
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  {technical.length}
                  <ChevronDown
                    aria-hidden="true"
                    className="transition-transform group-data-[state=open]:rotate-180 motion-reduce:transition-none"
                  />
                </span>
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <ol className="border-t px-4 py-2">
                {technical.map((event) => (
                  <li
                    key={event.seq}
                    className="flex items-center justify-between gap-4 border-b py-2 text-xs last:border-0"
                  >
                    <span className="capitalize">
                      {technicalLabel(event.type)}
                    </span>
                    <time className="text-muted-foreground">
                      {timestamp(event.at)}
                    </time>
                  </li>
                ))}
              </ol>
            </CollapsibleContent>
          </Collapsible>
        )}
      </section>
    </>
  );
}

function CallDetailSkeleton() {
  return (
    <div className="space-y-6" aria-label="Loading call detail">
      <Skeleton className="h-5 w-72 max-w-full" />
      <div className="grid overflow-hidden rounded-lg border sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="space-y-2 border-b p-4 lg:border-r">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-5 w-32 max-w-full" />
          </div>
        ))}
      </div>
      <Skeleton className="h-36 w-full rounded-lg" />
    </div>
  );
}

export default function CallDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <main className="space-y-8">
      <header className="space-y-4">
        <Button variant="ghost" size="sm" asChild className="-ml-3">
          <Link href="/calls">
            <ArrowLeft aria-hidden="true" />
            All calls
          </Link>
        </Button>
        <h1 className="text-2xl font-semibold tracking-tight">Call detail</h1>
      </header>
      <Suspense fallback={<CallDetailSkeleton />}>
        <CallDetailContent params={params} />
      </Suspense>
    </main>
  );
}
