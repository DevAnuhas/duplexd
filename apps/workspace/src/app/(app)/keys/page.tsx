import Link from 'next/link';
import { redirect } from 'next/navigation';

import { listApiKeysForAccount } from '@/data/api-keys';
import { getCurrentAccount } from '@/lib/account';
import { KeyManager } from './key-manager';

/**
 * `no-store` is not a performance choice.
 *
 * A minted key is shown exactly once, and a cached page is another copy of
 * that moment — in a CDN, a proxy, or the browser's back-forward cache, where
 * it outlives the one view it was meant to have.
 */
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

export default async function KeysPage() {
  const account = await getCurrentAccount();

  if (account === null) {
    redirect('/sign-in');
  }

  const keys = await listApiKeysForAccount(account.accountId);

  return (
    <main>
      <h1>API keys</h1>
      <p>
        <Link href="/assistants">Assistants</Link>
      </p>
      <KeyManager keys={keys} />
    </main>
  );
}
