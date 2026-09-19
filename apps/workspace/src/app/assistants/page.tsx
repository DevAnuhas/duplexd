import Link from 'next/link';
import { redirect } from 'next/navigation';

import { listAssistantsForAccount } from '@/data/assistants';
import { getCurrentAccount } from '@/lib/account';
import { ArchiveButton } from './archive-button';

export const dynamic = 'force-dynamic';

export default async function AssistantsPage() {
  const account = await getCurrentAccount();

  if (account === null) {
    redirect('/sign-in');
  }

  const assistants = await listAssistantsForAccount(account.accountId);

  return (
    <main>
      <h1>Assistants</h1>
      <p>
        <Link href="/assistants/new">Create an assistant</Link> ·{' '}
        <Link href="/keys">API keys</Link>
      </p>

      {assistants.length === 0 ? (
        <p>No assistants yet.</p>
      ) : (
        <ul>
          {assistants.map((assistant) => (
            <li key={assistant.id}>
              <Link href={`/assistants/${assistant.id}`}>{assistant.name}</Link>
              {' — '}
              {assistant.hasServerSecret ? 'secret set' : 'no secret'}
              <ArchiveButton assistantId={assistant.id} />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
