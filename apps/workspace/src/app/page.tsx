import Link from 'next/link';
import { redirect } from 'next/navigation';

import { getCurrentAccount } from '@/lib/account';
import { SignOutButton } from './sign-out-button';

/**
 * The authenticated shell. Empty on purpose: assistants and API keys are P03.
 *
 * Dynamic because it reads the session, and therefore the database. Without
 * this, `next build` would try to prerender it and would need a reachable
 * database at image-build time.
 */
export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const account = await getCurrentAccount();

  if (account === null) {
    redirect('/sign-in');
  }

  return (
    <main>
      <h1>Workspace</h1>
      <p>
        Signed in. Account <code>{account.accountId}</code>.
      </p>
      <p>
        <Link href="/assistants">Assistants</Link> ·{' '}
        <Link href="/keys">API keys</Link>
      </p>
      <SignOutButton />
    </main>
  );
}
