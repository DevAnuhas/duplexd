'use client';

import { useRouter } from 'next/navigation';
import { useTheme } from 'next-themes';
import { CaretUpDown as ChevronsUpDown, Laptop, Moon, SignOut as LogOut, Sun } from '@phosphor-icons/react';
import { useState } from 'react';

import { authClient } from '@/lib/auth-client';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar';

/**
 * The signed-in user, and the two things they can actually do.
 *
 * The scaffold's block shipped Upgrade to Pro, Account, Billing and
 * Notifications. None of those exist, so none of them are here.
 */
export function NavUser({ email }: { email: string }) {
  const { isMobile } = useSidebar();
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const [signingOut, setSigningOut] = useState(false);

  /**
   * `router.refresh()` after the redirect, not instead of it.
   *
   * The shell is server-rendered from the session, so a push alone can leave
   * the previous tenant's name and counts painted on the sign-in page until
   * something else invalidates the tree. Refreshing discards that render.
   */
  async function signOut() {
    setSigningOut(true);

    try {
      await authClient.signOut();
      router.push('/sign-in');
      router.refresh();
    } finally {
      setSigningOut(false);
    }
  }

  const initial = email.slice(0, 1).toUpperCase();

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              tooltip={email}
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <div className="bg-sidebar-accent text-sidebar-accent-foreground flex aspect-square size-8 items-center justify-center rounded-lg text-xs font-medium">
                {initial}
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate">{email}</span>
              </div>
              <ChevronsUpDown className="ml-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>

          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
            side={isMobile ? 'bottom' : 'right'}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
              {email}
            </DropdownMenuLabel>

            <DropdownMenuSeparator />

            <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
              Theme
            </DropdownMenuLabel>
            {/*
              `theme` is undefined until next-themes has read the stored
              preference on the client, which is one render after mount.
              Falling back to `system` keeps the radio group from flashing
              unselected — and `system` is the real default, so the fallback
              tells the truth rather than guessing.
            */}
            <DropdownMenuRadioGroup value={theme ?? 'system'} onValueChange={setTheme}>
              <DropdownMenuRadioItem value="light">
                <Sun className="size-4" />
                Light
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">
                <Moon className="size-4" />
                Dark
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="system">
                <Laptop className="size-4" />
                System
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>

            <DropdownMenuSeparator />

            <DropdownMenuItem
              disabled={signingOut}
              onSelect={(event) => {
                // The menu would close and unmount mid-request otherwise, and
                // the disabled state would never be seen.
                event.preventDefault();
                void signOut();
              }}
            >
              <LogOut className="size-4" />
              {signingOut ? 'Signing out…' : 'Sign out'}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
