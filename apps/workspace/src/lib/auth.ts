import { randomUUID } from 'node:crypto';

import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';

import { getDb } from '@/db/client';
import { requireAuthSecret, requireAuthUrl } from '@/db/env';
import * as schema from '@/db/schema';

/**
 * Better Auth, constructed on first use.
 *
 * Lazy for the same reason the database client is: building this at module
 * import would pull `DATABASE_URL` and `BETTER_AUTH_SECRET` into `next build`,
 * and the production image must build with no database and no secrets.
 *
 * **The session is security-critical, and an earlier version of this comment
 * said the opposite.** It read "login is the half of authentication that just
 * needs to work", on the reasoning that API keys are what an integrating
 * project actually holds. That is wrong, and it is wrong in the way that
 * propagates: the next reader deprioritises the thing it dismisses.
 *
 * A session mints API keys and edits webhook targets and secrets. Its blast
 * radius is therefore every key it can issue and every webhook it can
 * redirect — a stolen session is worth strictly more than any single key,
 * because it can mint more.
 *
 * Two consequences worth knowing before changing anything here:
 *
 *  - **Session posture is not observable from the test suite.** Better Auth
 *    derives `skipOriginCheck` from `isTest()`, so under Vitest the origin
 *    check returns before comparing anything. A probe run there reports a
 *    cross-origin sign-in succeeding whether or not production would reject
 *    it — measuring the absence of a check that is switched off. Assert this
 *    against a running server, or not at all.
 *  - `Secure` and the `__Secure-` cookie prefix follow `BETTER_AUTH_URL`'s
 *    scheme, which is why that variable is required and validated at boot
 *    rather than derived from the request.
 */

function createAuth() {
  return betterAuth({
    secret: requireAuthSecret(),
    baseURL: requireAuthUrl(),
    database: drizzleAdapter(getDb(), {
      provider: 'pg',
      schema: {
        user: schema.users,
        session: schema.sessions,
        account: schema.authAccounts,
        verification: schema.verifications,
      },
    }),
    emailAndPassword: {
      enabled: true,
    },
    /**
     * Rate limiting, with the auth endpoints held tighter than the default.
     *
     * This is the mitigation for signup account enumeration, which P02 cannot
     * close outright. Signing up with an address that already exists returns
     * 422 `USER_ALREADY_EXISTS`, and a new address returns 200 — so a prober
     * learns whether an address is registered.
     *
     * Returning an identical body for both would be theatre: a successful
     * signup issues a session cookie and a duplicate does not, so `set-cookie`
     * distinguishes them whatever the body says. Closing it properly means
     * signup stops creating a session and confirms by email instead, which
     * needs email infrastructure this ticket does not build.
     *
     * So the leak is made slow rather than pretended away, and recorded as a
     * residual in the pull request rather than quietly accepted.
     */
    rateLimit: {
      // Off under test: the suite drives concurrent signups deliberately, and
      // a limiter would reject them and hide what those tests exist to check.
      // The production build has it on, which is where it is verified.
      enabled: process.env.NODE_ENV !== 'test',
      window: 60,
      max: 60,
      customRules: {
        '/sign-up/email': { window: 60, max: 5 },
        '/sign-in/email': { window: 60, max: 10 },
      },
    },
    advanced: {
      /**
       * Where the client IP comes from.
       *
       * The rate limiter keys on `ip ?? NO_TRUSTED_IP_KEY`, so when no trusted
       * address can be resolved every caller shares a single bucket — and a
       * limiter meant to slow one prober would instead lock out everybody.
       * Behind Fly's proxy the socket address is the proxy, so the real client
       * comes from `fly-client-ip`.
       *
       * Only `fly-client-ip` is trusted, and deliberately not
       * `x-forwarded-for`. A client can set any header it likes; Fly overwrites
       * `fly-client-ip` on every proxied request, but `x-forwarded-for` is a
       * list the client can prepend to. Trusting it would let a prober send a
       * different forged address each time, land in a fresh bucket every
       * request, and skip the limit entirely — a limiter that is trivially
       * bypassed is worse than none, because it reads as protection.
       *
       * This is why the list is one header rather than a fallback chain: a
       * fallback is only as trustworthy as its weakest entry.
       *
       * The trust is in Fly Proxy, not in the header's name. `fly-client-ip`
       * is believable here only because Fly overwrites it on every proxied
       * request. Deployed anywhere that does not, a client can set it freely
       * and the limiter stops holding — so moving off Fly means revisiting
       * this line, not just the hostname.
       */
      ipAddress: {
        ipAddressHeaders: ['fly-client-ip'],
      },
    },
    user: {
      additionalFields: {
        accountId: {
          type: 'string',
          // `required` here means "the signup request must supply it", which
          // it cannot: `input: false` stops a client from sending `accountId`
          // at all, and Better Auth validates required fields against the
          // request body *before* any database hook runs. The two together are
          // unsatisfiable and reject every signup with `MISSING_FIELD`.
          //
          // The invariant is enforced where it belongs instead: `account_id`
          // is NOT NULL with a foreign key, and the `before` hook below fills
          // it. A row without an account cannot reach the table.
          required: false,
          input: false,
        },
      },
    },
    databaseHooks: {
      user: {
        create: {
          /**
           * Signup creates the account the user will belong to.
           *
           * **This is not transactional, and an earlier version of this
           * comment wrongly claimed it was.** Better Auth's Drizzle adapter
           * implements no `transaction`, so Better Auth patches it to a
           * pass-through — `adapter.transaction = async (cb) => cb(adapter)` —
           * after logging that the adapter does not implement it. `createUser`
           * does not wrap this hook in one either.
           *
           * What that costs is bounded, and it is worth being exact about the
           * direction. The account is written *first*, so the failure mode is
           * an orphan `accounts` row, never a user without an account — which
           * the schema forbids outright, since `account_id` is NOT NULL with a
           * foreign key. Better Auth rejects a duplicate email before this hook
           * runs, so a sequential duplicate strands nothing; only genuinely
           * concurrent signups for the same address can slip past that check
           * and leave a row behind.
           *
           * An orphan account is inert: nothing resolves to it, because the
           * only route to an account is through a user's `account_id`. It is
           * untidy rather than dangerous, and the honest fix is a real
           * transaction once the adapter supports one, not a comment claiming
           * one already exists.
           */
          before: async (user) => {
            const accountId = randomUUID();

            await getDb().insert(schema.accounts).values({
              id: accountId,
              name: user.email,
            });

            return { data: { ...user, accountId } };
          },
        },
      },
    },
  });
}

let auth: ReturnType<typeof createAuth> | undefined;

export function getAuth(): ReturnType<typeof createAuth> {
  auth ??= createAuth();

  return auth;
}
