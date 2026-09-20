import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { AppSidebar } from '@/components/app-sidebar';
import { BreadcrumbTrail } from '@/components/breadcrumb-trail';
import { Separator } from '@/components/ui/separator';
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from '@/components/ui/sidebar';
import { getShellContext } from '@/data/accounts';
import { getCurrentAccount } from '@/lib/account';

/**
 * The signed-in shell.
 *
 * **Why this is a route group and not the root layout.** Two things depend on
 * it and both break quietly if the shell moves up:
 *
 *  1. `/sign-in` and `/sign-up` must stay outside it. A root-level shell would
 *     read the session on the login page and render a sidebar for a tenant who
 *     is not signed in.
 *  2. `/keys` sets `fetchCache = 'force-no-store'` because a minted key is
 *     shown exactly once and a cached page is a second copy of that moment. A
 *     layout above it that caches would undo that, and the regression would
 *     look like a tidy-up in review.
 *
 * Dynamic for the same reason every page under it is: it reads the session,
 * and therefore the database.
 */
export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const account = await getCurrentAccount();

  if (account === null) {
    redirect('/sign-in');
  }

  const shell = await getShellContext(account.accountId, account.userId);

  if (shell === null) {
    // The session resolved to an account whose row no longer exists — a
    // deleted tenant holding a live cookie. Treat it as signed out rather than
    // rendering a shell with no identity in it.
    redirect('/sign-in');
  }

  return (
    /*
      `h-svh overflow-hidden` rather than the default `min-h-svh`, and
      `min-h-0` on the inset.

      This is what makes `main` an actual scroll container. Left to grow, the
      shell scrolls the window instead, `overflow-auto` on `main` never
      engages, and a page's `sticky top-0` anchors to the viewport — sliding
      under this header rather than resting below it. The assistant editor's
      jump-link bar depends on getting this right. A flex child also needs
      `min-h-0` or it refuses to shrink below its content and overflows the
      screen.
    */
    <SidebarProvider className="h-svh overflow-hidden">
      <AppSidebar
        account={{ id: shell.account.id, name: shell.account.name }}
        user={{ email: shell.userEmail }}
        counts={shell.counts}
      />
      <SidebarInset className="flex min-h-0 flex-1 flex-col">
        <header className="bg-background sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 h-4" />
          <BreadcrumbTrail accountName={shell.account.name} />
        </header>
        {/*
          `main` is the scroll container, so a page's own sticky elements — the
          assistant editor's jump-link bar, a table header — anchor to the top
          of the content area rather than to the viewport under the header.

          The width and padding live here, once. Pages return their content
          directly and must not repeat them.
        */}
        <main className="min-h-0 flex-1 overflow-auto">
          <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6">
            {children}
          </div>
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
