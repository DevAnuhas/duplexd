'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Gear as Settings, Key as KeyRound, Phone as PhoneCall, Robot as Bot, SquaresFour as LayoutGrid } from '@phosphor-icons/react';
import type { ComponentProps } from 'react';

import { NavUser } from '@/components/nav-user';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@/components/ui/sidebar';

/**
 * The tenant's navigation.
 *
 * **Everything here arrives as plain serializable props, rendered in the
 * initial HTML.** It used to receive `<Suspense>`-wrapped server slots so the
 * frame could prerender while the tenant streamed in. That cost the product
 * every control in this component: a client island reached through a streamed
 * boundary never hydrates, so sign out and the theme toggle were inert on
 * every page while looking perfectly normal. Streaming the shell's session
 * data is not worth a sidebar that cannot be clicked.
 *
 * **Every link is backed by a query that runs today.** No Phone numbers,
 * Squads, Webhooks, Integrations, Billing or Metrics — there is no data behind
 * any of them, and a greyed-out item with a "soon" pill is still a dead
 * button. Absence is honest; a link that goes nowhere teaches the tenant the
 * UI lies, and they then stop believing the parts that are load-bearing.
 */

type NavItem = {
  href: string;
  label: string;
  icon: typeof Bot;
  count?: number;
};

export type AccountSummary = { id: string; name: string };

export function AppSidebar({
  account,
  userEmail,
  counts,
  ...props
}: {
  account: AccountSummary;
  userEmail: string;
  counts: { assistants: number; apiKeys: number; calls: number };
} & ComponentProps<typeof Sidebar>) {
  const pathname = usePathname();

  const build: NavItem[] = [
    { href: '/', label: 'Overview', icon: LayoutGrid },
    { href: '/assistants', label: 'Assistants', icon: Bot, count: counts.assistants },
  ];
  const configure: NavItem[] = [
    { href: '/keys', label: 'API keys', icon: KeyRound, count: counts.apiKeys },
  ];
  const observe: NavItem[] = [
    { href: '/calls', label: 'Calls', icon: PhoneCall, count: counts.calls },
  ];

  /**
   * `/assistants/new` must light up `Assistants`, so this is a prefix match.
   *
   * `/` is the exception and needs the explicit guard: every path starts with
   * a slash, so a prefix test would light up Overview on every page.
   */
  const isActive = (href: string): boolean =>
    href === '/'
      ? pathname === '/'
      : pathname === href || pathname.startsWith(`${href}/`);

  const renderItems = (items: NavItem[]) =>
    items.map((item) => (
      <SidebarMenuItem key={item.href}>
        <SidebarMenuButton
          asChild
          isActive={isActive(item.href)}
          tooltip={item.label}
          className="h-11"
        >
          <Link href={item.href}>
            <item.icon />
            <span>{item.label}</span>
          </Link>
        </SidebarMenuButton>
        {/*
          Counts are queried, never decorative. Zero renders as nothing rather
          than as `0`: an empty section says so with its own empty state, and a
          badge reading zero beside every link is noise on a new account.
        */}
        {item.count !== undefined && item.count > 0 && (
          <SidebarMenuBadge>{item.count}</SidebarMenuBadge>
        )}
      </SidebarMenuItem>
    ));

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            {/*
              Who you are looking at — deliberately **not** a switcher. Both
              references put a chevron here because both have real multi-org;
              duplexd resolves exactly one account per session and has no route
              that could switch, so a chevron would promise a list that cannot
              exist. It links to Settings instead: same weight, same position,
              and it goes somewhere that does something.
            */}
            <SidebarMenuButton size="lg" asChild tooltip={account.name}>
              <Link href="/settings">
                <div className="bg-primary text-primary-foreground flex aspect-square size-8 items-center justify-center rounded-lg text-xs font-semibold">
                  {account.name.slice(0, 2).toUpperCase()}
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-semibold">{account.name}</span>
                  {/*
                    The first eight characters of the account id. It is the
                    identifier in every support conversation and every log
                    line, and showing it proves the boundary to a sceptical
                    tenant: two browsers, two ids.
                  */}
                  <span className="text-muted-foreground truncate text-xs tabular-nums">
                    acct {account.id.slice(0, 8)}
                  </span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>{renderItems(build)}</SidebarMenu>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Configure</SidebarGroupLabel>
          <SidebarMenu>{renderItems(configure)}</SidebarMenu>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Observe</SidebarGroupLabel>
          <SidebarMenu>{renderItems(observe)}</SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              isActive={isActive('/settings')}
              tooltip="Settings"
              className="h-11"
            >
              <Link href="/settings">
                <Settings />
                <span>Settings</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <NavUser email={userEmail} />
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}
