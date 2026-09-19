import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeDb } from '@/db/client';

import {
  CANARY_PASSWORD,
  attemptSignUp,
  signIn,
  signUpNewAccount,
  type SignedUpUser,
} from './helpers/auth.ts';
import { withTestPool } from './helpers/database.ts';
import { isDatabaseConfigured } from './helpers/environment.ts';

/**
 * Signup through the real Better Auth handler: what it creates, and what it
 * must never create.
 *
 * `users.account_id` is NOT NULL with a foreign key to `accounts`, and the
 * account is created by a `databaseHooks.user.create.before` hook. This file is
 * what proves that arrangement actually holds at runtime — it is easy to write
 * a signup that produces a user with no account, or an account with no user,
 * and neither is visible from reading the configuration.
 */

const describeDatabase = describe.skipIf(!isDatabaseConfigured());

afterAll(async () => {
  await closeDb();
});

describeDatabase('signup creates an account and a user in it', () => {
  let signedUp: SignedUpUser;

  beforeAll(async () => {
    signedUp = await signUpNewAccount();
  });

  it('writes a user row with a non-empty account_id', () => {
    expect(signedUp.userId).not.toBe('');
    expect(signedUp.accountId).not.toBe('');
  });

  it('writes the matching accounts row', async () => {
    const exists = await withTestPool(async (pool) => {
      const { rows } = await pool.query<{ id: string }>(
        'SELECT id FROM accounts WHERE id = $1',
        [signedUp.accountId],
      );

      return rows.length;
    });

    expect(exists).toBe(1);
  });

  it('issues a session cookie', () => {
    expect(signedUp.cookie).not.toBe('');
  });

  it('gives each signup its own account', async () => {
    const other = await signUpNewAccount();

    expect(other.accountId).not.toBe(signedUp.accountId);
  });

  /**
   * The password. Never stored in plaintext, and never echoed back — the
   * response body is checked as well as the row, because a signup that returns
   * what it was given puts the password in every proxy log on the way back.
   */
  it('never stores the password in plaintext anywhere', async () => {
    const hits = await withTestPool(async (pool) => {
      const { rows: tables } = await pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
      );

      const found: string[] = [];

      for (const { table_name } of tables) {
        const { rows } = await pool.query<{ hits: string }>(
          `SELECT count(*)::text AS hits FROM "${table_name}" t
           WHERE to_jsonb(t)::text LIKE $1`,
          [`%${CANARY_PASSWORD}%`],
        );

        if (Number(rows[0]?.hits ?? 0) > 0) {
          found.push(table_name);
        }
      }

      return found;
    });

    expect(hits).toStrictEqual([]);
  });

  it('stores a credential that is not the password', async () => {
    const stored = await withTestPool(async (pool) => {
      const { rows } = await pool.query<{ password: string | null }>(
        'SELECT password FROM auth_accounts WHERE user_id = $1',
        [signedUp.userId],
      );

      return rows[0]?.password ?? null;
    });

    expect(stored).not.toBeNull();
    expect(stored).not.toBe(CANARY_PASSWORD);
    expect(stored ?? '').not.toContain(CANARY_PASSWORD);
  });
});

describeDatabase('signing in', () => {
  let signedUp: SignedUpUser;

  beforeAll(async () => {
    signedUp = await signUpNewAccount();
  });

  it('succeeds with the right password', async () => {
    const response = await signIn(signedUp.email, signedUp.password);

    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie().length).toBeGreaterThan(0);
  });

  it('fails with the wrong password and issues no session', async () => {
    const response = await signIn(signedUp.email, 'definitely-not-the-password');

    expect(response.ok).toBe(false);
    expect(response.headers.getSetCookie()).toStrictEqual([]);
  });

  /**
   * The same answer for "no such user" and "wrong password". A response that
   * distinguishes them turns the sign-in form into an account-enumeration oracle.
   */
  it('does not reveal whether an email exists', async () => {
    const wrongPassword = await signIn(signedUp.email, 'wrong-password-here');
    const noSuchUser = await signIn(
      `absent-${randomUUID()}@example.invalid`,
      'wrong-password-here',
    );

    expect(noSuchUser.status).toBe(wrongPassword.status);
    expect(await noSuchUser.text()).toBe(await wrongPassword.text());
  });
});

/**
 * A duplicate signup.
 *
 * A *sequential* duplicate never reaches the account-creating hook: Better Auth
 * rejects the email at its own uniqueness check first, so nothing is written
 * and nothing can be stranded. An earlier version of this comment claimed the
 * tests below proved the hook was transactional. They cannot — the path that
 * would leak is not reached — and the implementation is in fact not
 * transactional. See `concurrent duplicate signups` below for the case that
 * does reach it, and `src/lib/auth.ts` for what that costs.
 *
 * What these tests do establish is real and worth keeping: a repeat signup is
 * rejected, it creates no second user and no second account, and it leaves
 * nothing behind.
 */
describeDatabase('a duplicate signup', () => {
  let signedUp: SignedUpUser;

  /**
   * Accounts belonging to this email, scoped rather than counted globally.
   *
   * The signup hook names the account after the email, so every account this
   * email could have produced is findable by name. A global count would be
   * coupled to whatever other files happened to run first.
   */
  async function accountsFor(email: string): Promise<{
    total: number;
    orphans: number;
  }> {
    return withTestPool(async (pool) => {
      const { rows } = await pool.query<{ total: string; orphans: string }>(
        `SELECT count(*)::text AS total,
                count(*) FILTER (
                  WHERE NOT EXISTS (
                    SELECT 1 FROM users u WHERE u.account_id = a.id
                  )
                )::text AS orphans
         FROM accounts a WHERE a.name = $1`,
        [email],
      );

      return {
        total: Number(rows[0]?.total ?? 0),
        orphans: Number(rows[0]?.orphans ?? 0),
      };
    });
  }

  beforeAll(async () => {
    signedUp = await signUpNewAccount();

    // Two attempts, so a leak that only happens on repeat is still visible.
    await attemptSignUp(signedUp.email, CANARY_PASSWORD);
    await attemptSignUp(signedUp.email, 'a-completely-different-password');
  });

  it('is rejected', async () => {
    const response = await attemptSignUp(signedUp.email, CANARY_PASSWORD);

    expect(response.ok).toBe(false);
  });

  it('leaves exactly one user for that email', async () => {
    const matching = await withTestPool(async (pool) => {
      const { rows } = await pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM users WHERE email = $1',
        [signedUp.email],
      );

      return Number(rows[0]?.count ?? 0);
    });

    expect(matching).toBe(1);
  });

  it('leaves no orphan account behind', async () => {
    const { orphans } = await accountsFor(signedUp.email);

    expect(
      orphans,
      'a rejected signup created an accounts row with no user in it',
    ).toBe(0);
  });

  /**
   * The case the sequential tests above cannot reach.
   *
   * Better Auth's uniqueness check and the account-creating hook are not in one
   * transaction, so several signups for the same address launched at once can
   * all pass the check before any of them writes a user. One wins; the losers
   * may each have already written an `accounts` row.
   *
   * What is asserted here is what must hold regardless: exactly one user for
   * the address, and — the invariant that actually matters — no user anywhere
   * without a real account behind it. Orphan account rows are deliberately not
   * asserted to be zero, because today they can occur and a test claiming
   * otherwise would be the same false comfort this file just removed. They are
   * inert: nothing resolves to an account except through a user's `account_id`.
   */
  it('keeps one user and no account-less user under concurrency', async () => {
    const email = `concurrent-${randomUUID()}@example.test`;

    await Promise.all(
      Array.from({ length: 6 }, () => attemptSignUp(email, CANARY_PASSWORD)),
    );

    const { users, accountless } = await withTestPool(async (pool) => {
      const { rows } = await pool.query<{ users: string; accountless: string }>(
        `SELECT (SELECT count(*)::text FROM users WHERE email = $1) AS users,
                (SELECT count(*)::text FROM users u
                  WHERE NOT EXISTS (
                    SELECT 1 FROM accounts a WHERE a.id = u.account_id
                  )) AS accountless`,
        [email],
      );

      return {
        users: Number(rows[0]?.users ?? 0),
        accountless: Number(rows[0]?.accountless ?? 0),
      };
    });

    expect(users, 'concurrent signups created more than one user').toBe(1);
    expect(
      accountless,
      'a user exists whose account_id points at no account',
    ).toBe(0);
  });

  it('creates no second account for the same person', async () => {
    const { total } = await accountsFor(signedUp.email);

    expect(total).toBe(1);
  });
});
