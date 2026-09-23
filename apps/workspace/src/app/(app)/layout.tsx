import type { ReactNode } from "react"

import { AppSidebar } from "@/components/app-sidebar"
import { BreadcrumbTrail } from "@/components/breadcrumb-trail"
import { PracticeSessionProvider } from "@/components/sandbox/practice-session"
import { Separator } from "@/components/ui/separator"
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"

import { requireShell } from "./shell-data"

/**
 * The signed-in shell.
 *
 * **This awaits the tenant and renders it into the initial HTML. It does not
 * stream, and that is the whole point.**
 *
 * It used to be synchronous, with the identity block, user menu, counts and
 * breadcrumb arriving as `<Suspense>`-wrapped server slots so the frame could
 * be part of a prerendered static shell. Every one of those slots contained or
 * was a client component, and **a client island delivered through a streamed
 * Suspense boundary never hydrates** — verified in production on Vercel and
 * locally, down to a stock probe with no providers at all. The markup looked
 * correct and every control in it was inert: sign out and the theme toggle did
 * nothing, on every page, silently.
 *
 * So the shell blocks on the session. That costs the prerendered shell and
 * partial prerendering with it — see `next.config.ts` — and buys a sidebar
 * whose buttons work. A shell that paints instantly and cannot be clicked is
 * not a faster product, it is a broken one.
 *
 * **Why this is a route group and not the root layout.** Two things depend on
 * it and both break quietly if the shell moves up:
 *
 *  1. `/sign-in` and `/sign-up` must stay outside it. A root-level shell would
 *     read the session on the login page and render a sidebar for someone who
 *     is not signed in.
 *  2. `/keys` shows a minted key exactly once, so that page must never be
 *     cached. It sets its own `fetchCache = 'force-no-store'`, and keeping the
 *     shell out of the root layout means no caching directive added up there
 *     can reach it.
 *
 * Dynamic because it reads the session, and therefore the database. Without
 * this, `next build` would try to prerender it and would need a reachable
 * database at build time.
 */
export const dynamic = "force-dynamic"

export default async function AppLayout({ children }: { children: ReactNode }) {
  const shell = await requireShell()

  return (
    /*
      `h-svh overflow-hidden` rather than the default `min-h-svh`, and
      `min-h-0` on the inset and the scroll container.

      This is what makes the content area an actual scroll container. Left to
      grow, the shell scrolls the window instead, `overflow-auto` never
      engages, and a page's `sticky top-0` anchors to the viewport — sliding
      under this header rather than resting below it. The assistant editor's
      jump-link bar depends on getting this right. A flex child also needs
      `min-h-0` or it refuses to shrink below its content and overflows.
    */
    <PracticeSessionProvider>
      <SidebarProvider className="h-svh overflow-hidden">
        <AppSidebar
          account={{ id: shell.account.id, name: shell.account.name }}
          userEmail={shell.userEmail}
          userName={shell.userName}
          counts={shell.counts}
        />
        <SidebarInset className="flex min-h-0 flex-1 flex-col">
          <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b bg-background px-4">
            {/* size-11 rather than the 28px default: 44px minimum target. */}
            <SidebarTrigger className="-ml-1 size-11" />
            <Separator orientation="vertical" className="mr-2 h-4" />
            <BreadcrumbTrail accountName={shell.account.name} />
          </header>
          {/*
          A `div`, not a `main`. **`SidebarInset` already renders `<main>`**,
          so wrapping the content in another one nested `<main>` inside
          `<main>` — invalid HTML, and the kind the parser is entitled to
          rearrange.

          The width and padding live here, once. Pages return their content
          directly and must not repeat them.
        */}
          <div className="min-h-0 flex-1 overflow-auto">
          <div className="mx-auto w-full max-w-5xl px-4 pt-6 pb-24 sm:px-6">
              {children}
            </div>
          </div>
        </SidebarInset>
      </SidebarProvider>
    </PracticeSessionProvider>
  )
}
