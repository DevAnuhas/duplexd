import Link from 'next/link';
import { redirect } from 'next/navigation';

import { listCallsForAccount } from '@/data/calls';
import { getCurrentAccount } from '@/lib/account';

export const dynamic = 'force-dynamic';

function duration(value: number | null): string {
  return value === null ? 'not reported' : `${value.toFixed(3)} seconds`;
}

export default async function CallsPage() {
  const account = await getCurrentAccount();

  if (account === null) {
    redirect('/sign-in');
  }

  const result = await listCallsForAccount(account.accountId);

  if (result.kind !== 'ok') {
    throw new Error('The initial calls page cannot have an invalid cursor.');
  }

  return (
    <main>
      <h1>Calls</h1>
      <p>
        <Link href="/assistants">Assistants</Link> ·{' '}
        <Link href="/keys">API keys</Link>
      </p>

      {result.calls.length === 0 ? (
        <p>No calls yet.</p>
      ) : (
        <ul>
          {result.calls.map((call) => (
            <li key={call.id}>
              <Link href={`/calls/${call.id}`}>{call.id}</Link>
              {' — '}
              {call.state}
              {' — '}
              {duration(call.durationSecs)}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
