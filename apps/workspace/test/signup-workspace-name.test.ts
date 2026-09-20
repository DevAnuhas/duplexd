import { randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';

import { closeDb } from '@/db/client';
import { getAuth } from '@/lib/auth';

import { withTestPool } from './helpers/database.ts';
import { isDatabaseConfigured } from './helpers/environment.ts';

/**
 * The workspace name's trip from the signup body to `accounts.name`.
 *
 * This is the one piece of the signup path that is not obvious from reading
 * either end. `workspaceName` is **not** a column on `users`: it rides the
 * request body, survives Better Auth's validation, and is read off the endpoint
 * context inside `databaseHooks.user.create.before`. Two library details have
 * to hold for that to work, and both were verified by reading
 * `node_modules/better-auth@1.7.5` rather than assumed:
 *
 *  - `dist/api/routes/sign-up.mjs` ends its body schema with
 *    `}).and(z.record(z.string(), z.any()))` — an intersection with a
 *    catch-all, so unknown keys survive validation instead of being stripped;
 *  - `dist/db/with-hooks.mjs` invokes the hook as `toRun(actualData, context)`,
 *    so the endpoint context — and with it `context.body` — reaches the hook.
 *
 * If either changes in a future Better Auth, the workspace name silently
 * becomes the email and nobody finds out from a type error. That is what this
 * file exists to catch, which is why every assertion reads `accounts` back
 * with a raw `SELECT` rather than through `getAccountProfile` — a read sharing
 * a bug with the write would agree with it and the pair would pass together.
 *
 * Nothing is mocked. Real Better Auth handler, real signup, real database.
 */

/** Where the handler thinks it lives. Better Auth parses the path from this. */
const ORIGIN = 'http://localhost:3000';

/** Distinctive and unique per run, so rows from an earlier run cannot match. */
function uniqueEmail(): string {
  return `workspace-${randomUUID()}@example.invalid`;
}

const PASSWORD = `signup-password-${randomUUID()}`;

/** Posts a signup body verbatim, so a case can omit a field entirely. */
async function signUp(body: Record<string, unknown>): Promise<Response> {
  return getAuth().handler(
    new Request(`${ORIGIN}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

type StoredNames = {
  accountId: string;
  accountName: string;
  personName: string | null;
};

/** The account and user rows for an address, straight out of the tables. */
async function storedNamesFor(email: string): Promise<StoredNames | null> {
  return withTestPool(async (pool) => {
    const { rows } = await pool.query<{
      account_id: string;
      account_name: string;
      person_name: string | null;
    }>(
      `SELECT a.id AS account_id, a.name AS account_name, u.name AS person_name
         FROM users u
         JOIN accounts a ON a.id = u.account_id
        WHERE u.email = $1`,
      [email],
    );

    const row = rows[0];

    return row === undefined
      ? null
      : {
          accountId: row.account_id,
          accountName: row.account_name,
          personName: row.person_name,
        };
  });
}

/**
 * Signs up and returns what landed in the database.
 *
 * Signup failures throw with the response body rather than returning a null
 * that a later assertion would report as "the name was wrong".
 */
async function signUpAndRead(
  body: Record<string, unknown>,
): Promise<StoredNames> {
  const response = await signUp(body);

  if (!response.ok) {
    throw new Error(
      `Signup failed with ${response.status}: ${await response.text()}`,
    );
  }

  const stored = await storedNamesFor(body.email as string);

  if (stored === null) {
    throw new Error('Signup reported success but wrote no user row.');
  }

  return stored;
}

const describeDatabase = describe.skipIf(!isDatabaseConfigured());

afterAll(async () => {
  await closeDb();
});

describeDatabase('the workspace name given at signup', () => {
  /**
   * The test the file exists for.
   *
   * The assertion that the account is **not** named after the email is the
   * load-bearing half. Without it, a hook that ignored the context entirely
   * would still satisfy "an account exists with a name", and the fallback
   * below would make that look deliberate.
   */
  it('names the account, and the person separately', async () => {
    const email = uniqueEmail();
    const stored = await signUpAndRead({
      email,
      password: PASSWORD,
      name: 'Alex Doe',
      workspaceName: 'Acme Logistics',
    });

    expect(
      stored.accountName,
      'the workspace name did not reach accounts.name',
    ).toBe('Acme Logistics');

    expect(
      stored.accountName,
      'the account fell back to the email, so the context never arrived',
    ).not.toBe(email);

    expect(
      stored.personName,
      'the person name did not reach users.name',
    ).toBe('Alex Doe');
  });

  it('gives two signups their own separate workspaces', async () => {
    const first = await signUpAndRead({
      email: uniqueEmail(),
      password: PASSWORD,
      name: 'Alex Doe',
      workspaceName: 'First Workspace',
    });
    const second = await signUpAndRead({
      email: uniqueEmail(),
      password: PASSWORD,
      name: 'Sam Roe',
      workspaceName: 'Second Workspace',
    });

    expect(first.accountName).toBe('First Workspace');
    expect(second.accountName).toBe('Second Workspace');
    expect(first.accountId).not.toBe(second.accountId);
  });

  it('trims the workspace name before storing it', async () => {
    const stored = await signUpAndRead({
      email: uniqueEmail(),
      password: PASSWORD,
      name: 'Alex Doe',
      workspaceName: '  \tAcme Logistics\n  ',
    });

    expect(
      stored.accountName,
      'the padding survived into accounts.name',
    ).toBe('Acme Logistics');
  });

  /**
   * The fallback, which is deliberate and load-bearing.
   *
   * An older client or a direct API call that sends no workspace name must
   * still produce a usable account — `users.account_id` is NOT NULL, so the
   * alternative to a fallback is a signup that fails outright. An account named
   * after its owner's address is recoverable; the rename form on Settings
   * exists for exactly that.
   */
  it.each([
    ['the field is absent entirely', undefined],
    ['it is the empty string', ''],
    ['it is only whitespace', '   '],
    ['it is a tab and a newline', '\t\n'],
    // A non-string cannot come from the form, but it can come from a direct
    // API call, and the hook's `typeof` guard is what keeps `[object Object]`
    // out of the sidebar.
    ['it is a number', 42],
    ['it is null', null],
    ['it is an object', { name: 'Acme' }],
  ])('falls back to the email when %s', async (_label, workspaceName) => {
    const email = uniqueEmail();
    const body: Record<string, unknown> = {
      email,
      password: PASSWORD,
      name: 'Alex Doe',
    };

    if (workspaceName !== undefined) {
      body.workspaceName = workspaceName;
    }

    const stored = await signUpAndRead(body);

    expect(
      stored.accountName,
      'the account was not named after the email, so the fallback did not run',
    ).toBe(email);

    expect(
      stored.accountId,
      'the fallback produced no account at all',
    ).toMatch(/\S/);

    // The person's name is unaffected by the workspace name's absence.
    expect(stored.personName).toBe('Alex Doe');
  });

  /**
   * **This documents current behaviour, not desired behaviour.**
   *
   * The 120-character cap on the workspace name lives only in
   * `signUpSchema`, which is client-side validation. The hook applies no
   * length check of its own and `accounts.name` is an unbounded `text`
   * column, so a direct API call can name a workspace with an arbitrarily long
   * string — and that string then renders in the sidebar and the breadcrumb of
   * every page.
   *
   * `renameAccountAction` *does* enforce the cap server-side, so the two ways
   * of setting the same column disagree. If that is closed — by capping in the
   * hook — this test should be inverted to assert the rejection or the
   * truncation, and its failure is the intended signal rather than a
   * regression.
   */
  it('does not enforce the 120-character cap server-side', async () => {
    const email = uniqueEmail();
    const overlong = 'x'.repeat(500);
    const stored = await signUpAndRead({
      email,
      password: PASSWORD,
      name: 'Alex Doe',
      workspaceName: overlong,
    });

    expect(
      stored.accountName,
      'the cap is now enforced at signup — invert this test, it has done its job',
    ).toBe(overlong);
  });
});
