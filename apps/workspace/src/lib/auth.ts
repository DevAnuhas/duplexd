import { randomUUID } from 'node:crypto';

import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';

import { getDb } from '@/db/client';
import { requireAuthSecret } from '@/db/env';
import * as schema from '@/db/schema';

/**
 * Better Auth, constructed on first use.
 *
 * Lazy for the same reason the database client is: building this at module
 * import would pull `DATABASE_URL` and `BETTER_AUTH_SECRET` into `next build`,
 * and the production image must build with no database and no secrets.
 *
 * Login is the half of authentication that just needs to work. The half that
 * gets the care is API keys, which is what an integrating project actually
 * holds — those are P03, and they are deliberately not this.
 */

function createAuth() {
  return betterAuth({
    secret: requireAuthSecret(),
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
    user: {
      additionalFields: {
        accountId: {
          type: 'string',
          required: true,
          input: false,
        },
      },
    },
    databaseHooks: {
      user: {
        create: {
          /**
           * Signup creates the account the user will belong to, in the same
           * transaction Better Auth uses to insert the user.
           *
           * `users.account_id` is NOT NULL with a foreign key, so this cannot
           * half-succeed: if the account insert fails the user insert fails
           * with it, and there is no window in which a signed-up user exists
           * with nothing to own their rows.
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
