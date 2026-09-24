import { randomUUID } from "node:crypto"

import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"

import { getDb } from "@/db/client"
import { requireAuthSecret, resolveAuthBaseUrl } from "@/db/env"
import * as schema from "@/db/schema"
import { workspaceNameOrFallback } from "@/lib/auth-schemas"
import { sendPasswordResetEmail } from "@/lib/email"

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
 *  - **Origin and CSRF behavior needs the standalone-server test.** Better
 *    Auth derives `skipOriginCheck` from `isTest()`, so calling it inside the
 *    Vitest process bypasses the guard. `control-live-server.test.ts` launches
 *    a separate process with `isTest() === false` and checks foreign-origin,
 *    cross-site and accepted writes plus the session cookie attributes.
 *  - `Secure` and the `__Secure-` cookie prefix follow the base URL's scheme,
 *    which is why it is resolved and validated at boot rather than left to the
 *    request. On Vercel previews the base URL is `DynamicBaseURLConfig` with
 *    `protocol: 'https'` and an allowlist of the deployment's own two hosts —
 *    per-request, but never an origin the deployment does not already know
 *    about. See `resolveAuthBaseUrl` for why both hosts have to be accepted.
 */

function createAuth() {
  return betterAuth({
    secret: requireAuthSecret(),
    baseURL: resolveAuthBaseUrl(),
    database: drizzleAdapter(getDb(), {
      provider: "pg",
      schema: {
        user: schema.users,
        session: schema.sessions,
        account: schema.authAccounts,
        verification: schema.verifications,
      },
    }),
    emailAndPassword: {
      enabled: true,
      /**
       * Password reset delivery.
       *
       * Better Auth calls this from `POST /request-password-reset` with a
       * `url` it has already built — its own `/reset-password/:token`
       * callback, which validates the token and then redirects to the
       * `redirectTo` the client supplied, carrying `?token=`. So the email
       * sends Better Auth's `url` verbatim; constructing one here would
       * bypass the validation that callback performs.
       *
       * **Token lifetime is one hour** — `resetPasswordTokenExpiresIn`
       * defaults to `3600` seconds, confirmed by reading
       * `node_modules/better-auth/dist/api/routes/password.mjs` rather than
       * assumed from documentation for another version. The token is
       * single-use: `resetPassword` consumes it before changing anything, so
       * two concurrent requests with the same token cannot both succeed.
       *
       * **Failures are swallowed on purpose.** This callback runs inside the
       * request-password-reset endpoint, which returns an identical response
       * whether or not the address exists. Throwing here would make delivery
       * failure observable and turn that endpoint back into the account
       * enumeration oracle it is written to avoid — "error" would mean the
       * account exists and "success" would mean it does not.
       */
      sendResetPassword: async ({ user, url }) => {
        await sendPasswordResetEmail({ to: user.email, url })
      },
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
      enabled: process.env.NODE_ENV !== "test",
      window: 60,
      max: 60,
      customRules: {
        "/sign-up/email": { window: 60, max: 5 },
        "/sign-in/email": { window: 60, max: 10 },
      },
    },
    advanced: {
      /**
       * Where the client IP comes from.
       *
       * The rate limiter keys on `ip ?? NO_TRUSTED_IP_KEY`, so when no trusted
       * address can be resolved every caller shares a single bucket — and a
       * limiter meant to slow one prober would instead lock out everybody.
       * Behind Vercel's proxy the socket address is the proxy, so the real
       * client comes from `x-real-ip`, the single-valued address calculated by
       * Vercel Proxy and used by Vercel's own functions SDK.
       *
       * Vercel also documents that it overwrites `x-forwarded-for` to prevent
       * spoofing. `x-real-ip` is chosen anyway: it cannot turn into a forwarded
       * chain when another proxy is placed in front of Vercel, while Better
       * Auth deliberately refuses an untrusted multi-hop chain. That refusal
       * resolves no address and collapses every caller into the same bucket.
       *
       * This is why the list is one header rather than a fallback chain: a
       * fallback is only as trustworthy as its weakest entry.
       *
       * The trust is in Vercel Proxy's calculation, not in the header's name.
       * A platform that does not overwrite `x-real-ip`, or a front proxy that
       * replaces that contract, invalidates this choice and requires a new
       * single trusted header plus a deployed edge check.
       */
      ipAddress: {
        ipAddressHeaders: ["x-real-ip"],
      },
    },
    user: {
      additionalFields: {
        accountId: {
          type: "string",
          // `required` here means "the signup request must supply it", which
          // it cannot: `input: false` rejects a caller-supplied `accountId`
          // during body validation with `FIELD_NOT_ALLOWED`, before any
          // database hook runs. The two together would be unsatisfiable and
          // reject every signup.
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
          before: async (user, context) => {
            const accountId = randomUUID()

            /**
             * The workspace name the person typed at signup.
             *
             * It reaches this hook on the endpoint context rather than on
             * `user`, because it is not a column on `users` and should not
             * become one. That works because Better Auth's sign-up body schema
             * is `z.object({...}).and(z.record(z.string(), z.any()))` — an
             * intersection with a catch-all, so extra keys survive validation
             * and arrive intact. Verified by reading
             * `node_modules/better-auth/dist/api/routes/sign-up.mjs`.
             *
             * `workspaceNameOrFallback` is shared with the rename action and
             * the form schema, so all three agree on what "blank" and "too
             * long" mean for this column. It previously guarded only against
             * `trim()`, which let a zero-width name through this endpoint that
             * Settings would refuse — and that then rendered blank in the
             * sidebar and breadcrumb of every page.
             *
             * **Falling back to the email is deliberate.** A signup that
             * arrives without a usable workspace name — an older client, a
             * direct API call — must still produce an account, and an account
             * named after its owner's address is recoverable: the rename form
             * on Settings exists precisely for that.
             */
            const workspaceName = workspaceNameOrFallback(
              (context as { body?: { workspaceName?: unknown } } | undefined)
                ?.body?.workspaceName,
              user.email
            )

            await getDb().insert(schema.accounts).values({
              id: accountId,
              name: workspaceName,
            })

            /*
              The signup body otherwise preserves catch-all fields — that is
              how `workspaceName` reaches this hook — but `input: false` above
              makes `accountId` the exception. Better Auth rejects it during
              body validation with `FIELD_NOT_ALLOWED`, so it never reaches
              this hook.

              Writing our generated `accountId` after `...user` is a
              defense-in-depth backstop that is not exercised while
              `input: false` remains. Do not loosen that primary guard under
              the assumption that spread ordering alone protects the tenant
              boundary; add any new caller-settable field separately.
            */
            /**
             * `users.name` gets the same treatment as the account's.
             *
             * It arrives on Better Auth's own body, so the form schema is the
             * only thing bounding it — the same client-side-only shape the
             * workspace name had. It is what the user menu displays instead of
             * the address, so a zero-width name renders that menu blank.
             * Falling back to the email keeps the menu legible.
             */
            const displayName = workspaceNameOrFallback(user.name, user.email)

            return { data: { ...user, name: displayName, accountId } }
          },
        },
      },
    },
  })
}

let auth: ReturnType<typeof createAuth> | undefined

export function getAuth(): ReturnType<typeof createAuth> {
  auth ??= createAuth()

  return auth
}
