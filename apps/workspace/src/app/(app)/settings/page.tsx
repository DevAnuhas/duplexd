import { Suspense } from 'react';

import { CopyButton } from '@/components/copy-button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { listAccountMembers } from '@/data/accounts';

import { requireShell } from '../shell-data';
import { RenameForm } from './rename-form';

/** `18 Sep 2026` — unambiguous between `09/18` and `18/09` readers. */
function day(value: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(value);
}

/**
 * The organization's identity and its people.
 *
 * This page exists because of one line in `lib/auth.ts`: signup writes
 * `accounts.name = user.email`, so every tenant is named after the address
 * they signed up with until somebody renames it. The rename form is the whole
 * difference between a sidebar reading `kevin@boringhost.ai` and one reading
 * `Boring Host`.
 *
 * The page component is synchronous: the headings and card frames are static
 * and prerender with the shell, and each card's contents — all of which read
 * the tenant — stream in behind their own Suspense boundary.
 */
export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-muted-foreground">
          This organization&rsquo;s identity and people.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Organization name</CardTitle>
          <CardDescription>
            How this organization appears across duplexd. It defaults to the
            email address you signed up with.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Suspense fallback={<Skeleton className="h-9 w-full max-w-sm" />}>
            <RenameCard />
          </Suspense>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Account ID</CardTitle>
          <CardDescription>
            Every assistant, key and call in duplexd belongs to this account.
            Quote it in support requests.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Suspense fallback={<Skeleton className="h-7 w-80" />}>
            <AccountIdCard />
          </Suspense>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Created</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          <Suspense fallback={<Skeleton className="h-5 w-28" />}>
            <CreatedCard />
          </Suspense>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Members</CardTitle>
          <CardDescription>
            Everyone here can manage this organization&rsquo;s assistants, keys
            and calls.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Suspense fallback={<Skeleton className="h-24 w-full" />}>
            <MembersTable />
          </Suspense>

          {/*
            There is no Invite button, no Role column and no Remove action.
            None of them exist: there is no email delivery, no invites table,
            no roles, and removing the only user of an account would orphan
            every assistant, key and call behind a NOT NULL foreign key. This
            sentence is the honest version — it turns a thin page into a stated
            roadmap, which is the difference between a gap and a lie. It is
            static, so it renders with the frame rather than after the query.
          */}
          <p className="text-muted-foreground text-sm">
            Single-user workspace. Teammate access is not available yet.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

async function RenameCard() {
  const { account } = await requireShell();

  return <RenameForm currentName={account.name} />;
}

async function AccountIdCard() {
  const { account } = await requireShell();

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/*
        The full id, not a truncation. This is the one place a tenant can read
        it end to end, and the Copy button is how they get it somewhere else
        intact — Founders Grotesk ships no monospace cut, so tabular numerals
        and copy-and-compare do the work a mono face would otherwise do.
      */}
      {/*
        `break-all` is load-bearing at 375px. A UUID is 36 characters with no
        space in it, so it cannot wrap on its own: inside the card's padding
        the string is wider than the viewport allows, and without this the
        whole page scrolls sideways. The flex row already wraps the Copy
        button; this is what lets the value itself wrap.
      */}
      <code className="bg-muted min-w-0 break-all rounded px-2 py-1 text-sm tabular-nums">
        {account.id}
      </code>
      <CopyButton value={account.id} label="Copy ID" />
    </div>
  );
}

async function CreatedCard() {
  const { account } = await requireShell();

  return <>{day(account.createdAt)}</>;
}

async function MembersTable() {
  const { account } = await requireShell();
  const members = await listAccountMembers(account.id);

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Email</TableHead>
          <TableHead>Name</TableHead>
          <TableHead>Joined</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {members.map((member) => (
          <TableRow key={member.id}>
            <TableCell>{member.email}</TableCell>
            {/*
              Signup sets `users.name` to the email, and it may be null for a
              row written another way. An em dash beats repeating the address
              in both columns.
            */}
            <TableCell className="text-muted-foreground">
              {member.name === null || member.name === member.email
                ? '—'
                : member.name}
            </TableCell>
            <TableCell className="text-muted-foreground">
              {day(member.createdAt)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
