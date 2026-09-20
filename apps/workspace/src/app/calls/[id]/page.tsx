import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { getCallForAccount } from '@/data/calls';
import { getCurrentAccount } from '@/lib/account';

export const dynamic = 'force-dynamic';

function timestamp(value: string | null): string {
  return value === null ? 'not recorded' : value;
}

function duration(value: number | null): string {
  return value === null ? 'not reported' : `${value.toFixed(3)} seconds`;
}

export default async function CallDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const account = await getCurrentAccount();

  if (account === null) {
    redirect('/sign-in');
  }

  const { id } = await params;
  const result = await getCallForAccount(account.accountId, id);

  if (result === null) {
    notFound();
  }

  return (
    <main>
      <h1>Call {result.call.id}</h1>
      <p>
        <Link href="/calls">All calls</Link>
      </p>

      <dl>
        <dt>State</dt>
        <dd>{result.call.state}</dd>
        <dt>Ended reason</dt>
        <dd>{result.call.endedReason ?? 'not ended'}</dd>
        <dt>Created</dt>
        <dd>{result.call.createdAt}</dd>
        <dt>Started</dt>
        <dd>{timestamp(result.call.startedAt)}</dd>
        <dt>Ended</dt>
        <dd>{timestamp(result.call.endedAt)}</dd>
        <dt>Last heartbeat</dt>
        <dd>{timestamp(result.call.lastHeartbeatAt)}</dd>
        <dt>Duration</dt>
        <dd>{duration(result.call.durationSecs)}</dd>
      </dl>

      <h2>Events</h2>
      {result.events.length === 0 ? (
        <p>No events recorded.</p>
      ) : (
        <ol>
          {result.events.map((event) => (
            <li key={event.seq}>
              <code>{event.seq}</code> {event.type} at {event.at}
            </li>
          ))}
        </ol>
      )}
    </main>
  );
}
