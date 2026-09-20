import Link from 'next/link';

import { BreadcrumbTrail } from '@/components/breadcrumb-trail';
import { NavUser } from '@/components/nav-user';
import { Skeleton } from '@/components/ui/skeleton';
import {
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';

import { requireShell } from './shell-data';

/**
 * The request-time pieces of the shell.
 *
 * Everything here reads the session and therefore cannot be prerendered. Each
 * is rendered inside its own `<Suspense>` in the layout, so the sidebar frame,
 * the header and the page chrome are served from the static shell while these
 * stream in behind them.
 *
 * They are separate components rather than one, because a single boundary
 * around the whole sidebar would hold the nav links — which are static —
 * behind a database query. `requireShell` is `cache()`d, so the four of them
 * still cost one query between them.
 */

/**
 * Who you are looking at.
 *
 * **Deliberately not a switcher.** Both references put a chevron here because
 * both have real multi-org; duplexd resolves exactly one account per session
 * (`lib/account.ts`) and has no route that could switch. A chevron would
 * promise a list that cannot exist, and it would invite the one question a
 * tenancy UI exists to remove — "am I looking at the right organization?"
 *
 * It links to Settings instead: same weight, same position, and it goes
 * somewhere that does something. The day a second account is reachable this
 * becomes a switcher and nothing around it moves.
 */
export async function AccountIdentity() {
  const { account } = await requireShell();

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton size="lg" asChild tooltip={account.name}>
          <Link href="/settings">
            <div className="bg-primary text-primary-foreground flex aspect-square size-8 items-center justify-center rounded-lg text-xs font-semibold">
              {account.name.slice(0, 2).toUpperCase()}
            </div>
            <div className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-semibold">{account.name}</span>
              {/*
                The first eight characters of the account id. It is the
                identifier in every support conversation and every log line,
                and showing it proves the boundary to a sceptical tenant: two
                browsers, two ids. Tabular numerals keep the digits aligned
                without reaching for a second typeface.
              */}
              <span className="text-muted-foreground truncate text-xs tabular-nums">
                acct {account.id.slice(0, 8)}
              </span>
            </div>
          </Link>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

export function AccountIdentitySkeleton() {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <div className="flex items-center gap-2 p-2">
          <Skeleton className="size-8 rounded-lg" />
          <div className="grid flex-1 gap-1">
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="h-3 w-16" />
          </div>
        </div>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

/** The signed-in user's own menu: theme, and sign out. */
export async function UserMenuSlot() {
  const { userEmail } = await requireShell();

  return <NavUser email={userEmail} />;
}

export function UserMenuSkeleton() {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <div className="flex items-center gap-2 p-2">
          <Skeleton className="size-8 rounded-lg" />
          <Skeleton className="h-3.5 flex-1" />
        </div>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

/**
 * A queried count beside a nav link.
 *
 * Zero renders as nothing rather than as `0`: an empty section says so with
 * its own empty state, and a badge reading zero beside every link is noise on
 * a new account. There is no skeleton fallback — a shimmering pill appearing
 * and then vanishing because the count was zero is worse than the number
 * simply arriving.
 */
export async function CountBadge({
  of,
}: {
  of: 'assistants' | 'apiKeys' | 'calls';
}) {
  const { counts } = await requireShell();
  const count = counts[of];

  return count > 0 ? <SidebarMenuBadge>{count}</SidebarMenuBadge> : null;
}

/** `Boring Host / Assistants` in the page header. */
export async function BreadcrumbSlot() {
  const { account } = await requireShell();

  return <BreadcrumbTrail accountName={account.name} />;
}

export function BreadcrumbSkeleton() {
  return <Skeleton className="h-4 w-40" />;
}
