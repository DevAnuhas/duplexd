import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';

import { getDb } from '@/db/client';
import { users } from '@/db/schema';
import { getAuth } from '@/lib/auth';

/**
 * Signing up through the real Better Auth handler.
 *
 * This is the same entry point `src/app/api/auth/[...all]/route.ts` calls — a
 * `Request` in, a `Response` out — so the databaseHooks that create the
 * `accounts` row, the password hashing, and the session insert all run exactly
 * as they do in the application. Inserting an `accounts` row directly would be
 * quicker and would prove nothing about signup.
 */

/** Where the handler thinks it lives. Better Auth parses the path from this. */
const ORIGIN = 'http://localhost:3000';

export type SignedUpUser = {
  email: string;
  password: string;
  userId: string;
  accountId: string;
  /** A `cookie:` header value carrying the session, ready to replay. */
  cookie: string;
};

/**
 * A distinctive password, so a canary sweep for it cannot match by accident,
 * and unique per run so a leak left behind by an earlier run cannot keep every
 * later run red for a problem that is already fixed.
 */
export const CANARY_PASSWORD = `canary-password-${randomUUID()}`;

function authRequest(path: string, body: unknown): Request {
  return new Request(`${ORIGIN}/api/auth${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Collapses a response's `Set-Cookie` headers into a replayable `cookie` value. */
export function cookieHeaderFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0] ?? '')
    .filter((value) => value !== '')
    .join('; ');
}

/**
 * Creates an account by signing up, and returns everything needed to act as it.
 *
 * The email is unique per call so the suite can run repeatedly against the same
 * database without colliding with rows an earlier run left behind.
 */
export async function signUpNewAccount(
  overrides: { email?: string; password?: string } = {},
): Promise<SignedUpUser> {
  const email = overrides.email ?? `isolation-${randomUUID()}@example.invalid`;
  const password = overrides.password ?? CANARY_PASSWORD;

  const response = await getAuth().handler(
    authRequest('/sign-up/email', { email, password, name: email }),
  );

  if (!response.ok) {
    throw new Error(
      `Signup failed with ${response.status}: ${await response.text()}`,
    );
  }

  const row = await findUserByEmail(email);

  if (row === null) {
    throw new Error(`Signup reported success but wrote no user for ${email}.`);
  }

  return {
    email,
    password,
    userId: row.id,
    accountId: row.accountId,
    cookie: cookieHeaderFrom(response),
  };
}

/** Signs in an existing user, returning the raw response so failures are testable. */
export async function signIn(
  email: string,
  password: string,
): Promise<Response> {
  return getAuth().handler(authRequest('/sign-in/email', { email, password }));
}

/** Attempts a signup without asserting success, for the duplicate-email case. */
export async function attemptSignUp(
  email: string,
  password: string,
): Promise<Response> {
  return getAuth().handler(
    authRequest('/sign-up/email', { email, password, name: email }),
  );
}

/** The user row for an email, or `null`. */
export async function findUserByEmail(
  email: string,
): Promise<{ id: string; accountId: string } | null> {
  const rows = await getDb()
    .select({ id: users.id, accountId: users.accountId })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  return rows[0] ?? null;
}
