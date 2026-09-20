import { Suspense, type ReactNode } from 'react';

import { AppSidebar } from '@/components/app-sidebar';
import { Separator } from '@/components/ui/separator';
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from '@/components/ui/sidebar';

import {
  AccountIdentity,
  AccountIdentitySkeleton,
  BreadcrumbSkeleton,
  BreadcrumbSlot,
  CountBadge,
  UserMenuSkeleton,
  UserMenuSlot,
} from './shell-slots';

/**
 * The signed-in shell.
 *
 * **This component is synchronous on purpose.** Under Cache Components a read
 * of the session, `headers()`, `cookies()` or the database outside a
 * `<Suspense>` boundary is a build error, and rightly so: it would make the
 * whole shell request-time and there would be nothing left to prerender. So
 * the frame — sidebar structure, nav links, header, content wrapper — is
 * static and served immediately, and the four pieces that need the tenant
 * stream in behind their own boundaries. They share one query; see
 * `shell-data.ts`.
 *
 * **Why this is a route group and not the root layout.** Two things depend on
 * it and both break quietly if the shell moves up:
 *
 *  1. `/sign-in` and `/sign-up` must stay outside it. A root-level shell would
 *     read the session on the login page and render a sidebar for someone who
 *     is not signed in.
 *  2. `/keys` shows a minted key exactly once, so that page must never be
 *     cached. Under `cacheComponents` that is now true by construction —
 *     nothing is cached unless it is explicitly marked `'use cache'`, and
 *     nothing in this tree is — but keeping the shell out of the root layout
 *     means a future `'use cache'` added up there cannot reach it either.
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    /*
      `h-svh overflow-hidden` rather than the default `min-h-svh`, and
      `min-h-0` on the inset and main.

      This is what makes `main` an actual scroll container. Left to grow, the
      shell scrolls the window instead, `overflow-auto` on `main` never
      engages, and a page's `sticky top-0` anchors to the viewport — sliding
      under this header rather than resting below it. The assistant editor's
      jump-link bar depends on getting this right. A flex child also needs
      `min-h-0` or it refuses to shrink below its content and overflows.
    */
    <SidebarProvider className="h-svh overflow-hidden">
      <AppSidebar
        identity={
          <Suspense fallback={<AccountIdentitySkeleton />}>
            <AccountIdentity />
          </Suspense>
        }
        userMenu={
          <Suspense fallback={<UserMenuSkeleton />}>
            <UserMenuSlot />
          </Suspense>
        }
        assistantsBadge={
          <Suspense fallback={null}>
            <CountBadge of="assistants" />
          </Suspense>
        }
        apiKeysBadge={
          <Suspense fallback={null}>
            <CountBadge of="apiKeys" />
          </Suspense>
        }
        callsBadge={
          <Suspense fallback={null}>
            <CountBadge of="calls" />
          </Suspense>
        }
      />
      <SidebarInset className="flex min-h-0 flex-1 flex-col">
        <header className="bg-background sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 h-4" />
          <Suspense fallback={<BreadcrumbSkeleton />}>
            <BreadcrumbSlot />
          </Suspense>
        </header>
        {/*
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
