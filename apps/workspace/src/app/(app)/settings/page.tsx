import { redirect } from 'next/navigation';

import { CopyButton } from '@/components/copy-button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { getShellContext, listAccountMembers } from '@/data/accounts';
import { getCurrentAccount } from '@/lib/account';
import { RenameForm } from './rename-form';

export const dynamic = 'force-dynamic';

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
 */
export default async function SettingsPage() {
  const account = await getCurrentAccount();

  if (account === null) {
    redirect('/sign-in');
  }

  const shell = await getShellContext(account.accountId, account.userId);

  if (shell === null) {
    redirect('/sign-in');
  }

  const members = await listAccountMembers(account.accountId);

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
          <RenameForm currentName={shell.account.name} />
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
        <CardContent className="flex flex-wrap items-center gap-2">
          {/*
            The full id, not a truncation. This is the one place a tenant can
            read it end to end, and the Copy button is how they get it
            somewhere else intact — Founders Grotesk ships no monospace cut, so
            tabular numerals and copy-and-compare do the work that a mono face
            would otherwise do.
          */}
          <code className="bg-muted rounded px-2 py-1 text-sm tabular-nums">
            {shell.account.id}
          </code>
          <CopyButton value={shell.account.id} label="Copy ID" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Created</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          {day(shell.account.createdAt)}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            Members{' '}
            <span className="text-muted-foreground font-normal">
              — {members.length}
            </span>
          </CardTitle>
          <CardDescription>
            Everyone here can manage this organization&rsquo;s assistants, keys
            and calls.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
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
                    Signup sets `users.name` to the email, and it may be null
                    for a row written another way. An em dash beats repeating
                    the address in both columns.
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

          {/*
            There is no Invite button, no Role column and no Remove action.
            None of them exist: there is no email delivery, no invites table,
            no roles, and removing the only user of an account would orphan
            every assistant, key and call behind a NOT NULL foreign key. This
            sentence is the honest version — it turns a thin page into a stated
            roadmap, which is the difference between a gap and a lie.
          */}
          <p className="text-muted-foreground text-sm">
            Single-user workspace. Teammate access is not available yet.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
