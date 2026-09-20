import { Suspense } from 'react';

import { Skeleton } from '@/components/ui/skeleton';
import { listApiKeysForAccount } from '@/data/api-keys';
import { requireShell } from '../shell-data';
import { KeyManager } from './key-manager';

/**
 * With Cache Components, this uncached session/database read runs at request
 * time and is never stored. The one-time reveal therefore cannot be copied
 * into a prerender or page cache; only the client owner ever holds the raw key.
 */
async function KeysContent() {
  const { account } = await requireShell();
  const keys = await listApiKeysForAccount(account.id);

  return <KeyManager keys={keys} />;
}

export default function KeysPage() {
  return (
    <main className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">API keys</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Create credentials for projects that start calls through the API.
        </p>
      </header>
      <Suspense
        fallback={
          <div className="space-y-4" aria-label="Loading API keys">
            <Skeleton className="h-24 w-full rounded-lg" />
            <Skeleton className="h-56 w-full rounded-lg" />
          </div>
        }
      >
        <KeysContent />
      </Suspense>
    </main>
  );
}
