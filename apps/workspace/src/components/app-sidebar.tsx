'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Bot, KeyRound, LayoutGrid, PhoneCall, Settings } from 'lucide-react';
import { Suspense, type ComponentProps, type ReactNode } from 'react';

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
 * The links themselves prerender and are served immediately. Three kinds of
 * thing stream in behind Suspense boundaries: the identity block, the user
 * menu and the counts (passed in as slots by the layout), and the active-link
 * highlight (see `NavButton`).
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
  const build: NavItem[] = [
    { href: '/', label: 'Overview', icon: LayoutGrid },
    { href: '/assistants', label: 'Assistants', icon: Bot, badge: assistantsBadge },
  ];
  const configure: NavItem[] = [
    { href: '/keys', label: 'API keys', icon: KeyRound, badge: apiKeysBadge },
  ];
  const observe: NavItem[] = [
    { href: '/calls', label: 'Calls', icon: PhoneCall, badge: callsBadge },
  ];

  const renderItems = (items: NavItem[]) =>
    items.map((item) => (
      <SidebarMenuItem key={item.href}>
        <NavButton href={item.href} label={item.label} icon={item.icon} />
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
            <NavButton href="/settings" label="Settings" icon={Settings} />
          </SidebarMenuItem>
        </SidebarMenu>
        {userMenu}
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}

/**
 * A nav link whose highlight streams in after the link itself.
 *
 * `usePathname()` cannot run while the shell is being prerendered — under
 * Cache Components it is a build error (`CLIENT_HOOK_DYNAMIC`), because the
 * path is not knowable until there is a request. Wrapping only the highlight
 * keeps the rest static: the **fallback is the same link, unhighlighted**, so
 * the nav is present and clickable in the prerendered shell and the active
 * state settles a moment later. The alternative — one boundary around the
 * whole nav — would hold the links themselves behind a skeleton, which is the
 * thing partial prerendering exists to avoid.
 */
function NavButton({
  href,
  label,
  icon: Icon,
}: {
  href: string;
  label: string;
  icon: typeof Bot;
}) {
  /*
    `h-11` overrides the sidebar's 32px default to clear the 44px minimum
    target. Applied here rather than in `components/ui/sidebar.tsx`, because
    that variant is shared and changing it would silently resize controls in
    lanes I do not own.
  */
  const link = (isActive: boolean) => (
    <SidebarMenuButton asChild isActive={isActive} tooltip={label} className="h-11">
      <Link href={href}>
        <Icon />
        <span>{label}</span>
      </Link>
    </SidebarMenuButton>
  );

  return (
    <Suspense fallback={link(false)}>
      <ActiveNavButton href={href}>{link}</ActiveNavButton>
    </Suspense>
  );
}

function ActiveNavButton({
  href,
  children,
}: {
  href: string;
  children: (isActive: boolean) => ReactNode;
}) {
  const pathname = usePathname();

  /**
   * `/assistants/new` must light up `Assistants`, so this is a prefix match.
   *
   * `/` is the exception and needs the explicit guard: every path starts with
   * a slash, so a prefix test would light up Overview on every page in the
   * product.
   */
  const isActive =
    href === '/'
      ? pathname === '/'
      : pathname === href || pathname.startsWith(`${href}/`);

  return children(isActive);
}
