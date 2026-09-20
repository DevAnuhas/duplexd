import { headers } from "next/headers"

import { getAuth } from "@/lib/auth"

/**
 * The one place that answers "which account is this request acting as".
 *
 * Every read and write against `assistants`, `api_keys`, `calls` and
 * `call_events` is scoped by the value this returns. There is deliberately a
 * single resolver rather than each call site reaching into the session: two
 * ways to answer this question is how one of them ends up subtly different,
 * and the query that forgot to scope is never the one anybody writes a test
 * for.
 *
 * The account id comes from the server-side session, never from a request
 * parameter, a header, or anything else the caller can set.
 */
export type CurrentAccount = {
  accountId: string
  userId: string
}

/** Resolves the current account, or `null` when the request is unauthenticated. */
export async function getCurrentAccount(): Promise<CurrentAccount | null> {
  /**
   * **`await headers()` first, on its own line, before `getAuth()` is called.**
   *
   * This is ordering, not style. Written as
   * `getAuth().api.getSession({ headers: await headers() })`, the receiver
   * `getAuth()` is evaluated before the argument — so during a prerender the
   * auth instance is constructed, and `BETTER_AUTH_SECRET` is read, before
   * Next ever reaches the dynamic API that would postpone the render. The
   * build then fails with an unset secret on a page that was never meant to
   * be prerendered at all.
   *
   * Reading the dynamic API first lets Cache Components postpone at the
   * boundary, and nothing downstream of it is evaluated during the build.
   */
  const requestHeaders = await headers()

  const session = await getAuth().api.getSession({
    headers: requestHeaders,
  })

  if (session === null) {
    return null
  }

  const accountId = (session.user as { accountId?: unknown }).accountId

  // A session whose user carries no account is a broken row, not an
  // unauthenticated request. Returning null here would silently downgrade it
  // to "signed out" and hide the breakage.
  if (typeof accountId !== "string" || accountId === "") {
    throw new Error(
      `Session user ${session.user.id} has no account_id. This should be ` +
        "impossible: the column is NOT NULL and signup writes it."
    )
  }

  return { accountId, userId: session.user.id }
}

/** Resolves the current account, or throws. For paths that require a session. */
export async function requireCurrentAccount(): Promise<CurrentAccount> {
  const account = await getCurrentAccount()

  if (account === null) {
    throw new Error("Not authenticated.")
  }

  return account
}
