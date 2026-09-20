'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';

/**
 * `Boring Host / Assistants` — the tenant's name on every page, as both
 * references do it.
 *
 * **Two levels only, and the second is the section, never the record.** A
 * third crumb naming the assistant or the call would need its name, which
 * this client component cannot know without a fetch that duplicates the one
 * the page already did. Pages own their own `<h1>`, which is where the
 * specific record is named. A breadcrumb that says "Assistants / a1f2-…"
 * is worse than one that stops at "Assistants".
 */

const SECTIONS: Record<string, string> = {
  assistants: 'Assistants',
  keys: 'API keys',
  calls: 'Calls',
  settings: 'Settings',
};

export function BreadcrumbTrail({ accountName }: { accountName: string }) {
  const pathname = usePathname();
  const segment = pathname.split('/')[1] ?? '';
  const section = SECTIONS[segment];

  return (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          {section === undefined ? (
            <BreadcrumbPage>{accountName}</BreadcrumbPage>
          ) : (
            <BreadcrumbLink asChild>
              <Link href="/settings">{accountName}</Link>
            </BreadcrumbLink>
          )}
        </BreadcrumbItem>

        {section !== undefined && (
          <>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>{section}</BreadcrumbPage>
            </BreadcrumbItem>
          </>
        )}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
