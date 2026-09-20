'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Bot, KeyRound, PhoneCall, Settings } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@/components/ui/sidebar';

/**
 * The tenant's navigation — the **static** half of the shell.
 *
 * Nothing here reads the session or the database, so it prerenders and is
 * served immediately. The three request-time pieces arrive as slots: the
 * identity block, the user menu, and each link's count, every one of them
 * wrapped in its own `<Suspense>` by the layout.
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
  badge?: ReactNode;
};

export function AppSidebar({
  identity,
  userMenu,
  assistantsBadge,
  apiKeysBadge,
  callsBadge,
  ...props
}: {
  identity: ReactNode;
  userMenu: ReactNode;
  assistantsBadge: ReactNode;
  apiKeysBadge: ReactNode;
  callsBadge: ReactNode;
} & ComponentProps<typeof Sidebar>) {
  const pathname = usePathname();

  const build: NavItem[] = [
    { href: '/assistants', label: 'Assistants', icon: Bot, badge: assistantsBadge },
  ];
  const configure: NavItem[] = [
    { href: '/keys', label: 'API keys', icon: KeyRound, badge: apiKeysBadge },
  ];
  const observe: NavItem[] = [
    { href: '/calls', label: 'Calls', icon: PhoneCall, badge: callsBadge },
  ];

  /**
   * `/assistants/new` must light up `Assistants`, so this is a prefix match —
   * but an exact check first, or a bare `/` would match everything.
   */
  const isActive = (href: string): boolean =>
    pathname === href || pathname.startsWith(`${href}/`);

  const renderItems = (items: NavItem[]) =>
    items.map((item) => (
      <SidebarMenuItem key={item.href}>
        <SidebarMenuButton asChild isActive={isActive(item.href)} tooltip={item.label}>
          <Link href={item.href}>
            <item.icon />
            <span>{item.label}</span>
          </Link>
        </SidebarMenuButton>
        {item.badge}
      </SidebarMenuItem>
    ));

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>{identity}</SidebarHeader>

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
            <SidebarMenuButton asChild isActive={isActive('/settings')} tooltip="Settings">
              <Link href="/settings">
                <Settings />
                <span>Settings</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        {userMenu}
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}
