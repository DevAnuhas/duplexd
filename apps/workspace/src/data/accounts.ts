import { and, eq, sql } from 'drizzle-orm';

import { getDb } from '@/db/client';
import { accounts, apiKeys, assistants, calls, users } from '@/db/schema';

/**
 * Server-side data access for the account itself — the tenant's own identity,
 * as opposed to the things it owns.
 *
 * **Why this is not in `lib/account.ts`.** That file is the one resolver for
 * "which account is this request acting as", and it answers that from the
 * session alone, touching no database. Folding a name lookup into it would
 * give the security-critical resolver a second job and a new failure mode: a
 * database hiccup would then present as an authentication failure. The
 * convention in this layer is already the right one — a data function takes an
 * `accountId` from the resolver rather than reaching for the session itself.
 */

export type AccountProfile = {
  id: string;
  name: string;
  createdAt: Date;
};

/** The tenant's identity, for the sidebar and Settings. */
export async function getAccountProfile(
  accountId: string,
): Promise<AccountProfile | null> {
  const rows = await getDb()
    .select({
      id: accounts.id,
      name: accounts.name,
      createdAt: accounts.createdAt,
    })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Renames the account.
 *
 * **The id is a parameter of this function and never of a form.** Callers pass
 * what `requireCurrentAccount()` returned; there is no path by which a
 * submitted field reaches this `where` clause. That is the whole of the
 * protection: an action that read an `accountId` out of `FormData` would be
 * the first tenant-controlled scope parameter in this codebase, and it would
 * arrive through the one write nobody thinks to review.
 */
export async function renameAccount(
  accountId: string,
  name: string,
): Promise<void> {
  await getDb()
    .update(accounts)
    .set({ name })
    .where(eq(accounts.id, accountId));
}

export type ShellContext = {
  account: AccountProfile;
  userEmail: string;
  userName: string | null;
  counts: {
    assistants: number;
    apiKeys: number;
    calls: number;
    incompleteCalls: number;
  };
};

/**
 * Everything the signed-in shell renders, in one round trip.
 *
 * This runs on **every page render**, so it is deliberately one query rather
 * than four: the account row, the signed-in user's email for the footer, and
 * the three sidebar counts as scalar subqueries.
 *
 * Each count is scoped by `accountId` and counts exactly what its link
 * navigates to — an archived assistant is absent from `/assistants`, so it is
 * absent here; a revoked key still appears on `/keys`, so it is counted. A
 * badge that disagrees with the page it points at is the one lie a tenant can
 * catch instantly.
 *
 * The user is joined on **both** its id and its account, so a `userId` that
 * belongs to a different tenant returns nothing rather than that tenant's
 * email. Both values come from the same session today and cannot disagree —
 * the predicate is there so that it stays true if a caller ever passes a pair
 * from somewhere else.
 */
export async function getShellContext(
  accountId: string,
  userId: string,
): Promise<ShellContext | null> {
  const rows = await getDb()
    .select({
      id: accounts.id,
      name: accounts.name,
      createdAt: accounts.createdAt,
      userEmail: users.email,
      userName: users.name,
      assistants: sql<number>`(
        select count(*) from ${assistants}
        where ${assistants.accountId} = ${accounts.id}
          and ${assistants.archivedAt} is null
      )`.mapWith(Number),
      apiKeys: sql<number>`(
        select count(*) from ${apiKeys}
        where ${apiKeys.accountId} = ${accounts.id}
      )`.mapWith(Number),
      calls: sql<number>`(
        select count(*) from ${calls}
        where ${calls.accountId} = ${accounts.id}
      )`.mapWith(Number),
      /**
       * Calls the platform closed because the agent stopped reporting.
       *
       * Counted from the stored state, so a call that has gone stale but has
       * not been swept yet is still `active` here — the same thing the calls
       * list says. A number that disagrees with the page it links to is the
       * one lie a tenant can check instantly.
       */
      incompleteCalls: sql<number>`(
        select count(*) from ${calls}
        where ${calls.accountId} = ${accounts.id}
          and ${calls.state} = 'incomplete'
      )`.mapWith(Number),
    })
    .from(accounts)
    .innerJoin(
      users,
      and(eq(users.id, userId), eq(users.accountId, accounts.id)),
    )
    .where(eq(accounts.id, accountId))
    .limit(1);

  const row = rows[0];

  if (row === undefined) {
    return null;
  }

  return {
    account: { id: row.id, name: row.name, createdAt: row.createdAt },
    userEmail: row.userEmail,
    userName: row.userName,
    counts: {
      assistants: row.assistants,
      apiKeys: row.apiKeys,
      calls: row.calls,
      incompleteCalls: row.incompleteCalls,
    },
  };
}

export type AccountMember = {
  id: string;
  email: string;
  name: string | null;
  createdAt: Date;
};

/**
 * Everyone in the account.
 *
 * Returns exactly one row today, because `users.account_id` is the only link
 * and nothing writes a second user against an account. That is not a reason to
 * hard-code the single row: this is the real query, and it will return two the
 * day a membership model exists.
 */
export async function listAccountMembers(
  accountId: string,
): Promise<AccountMember[]> {
  return getDb()
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.accountId, accountId))
    .orderBy(users.createdAt);
}
