import { redirect } from "next/navigation"
import { cache } from "react"

import { getShellContext, type ShellContext } from "@/data/accounts"
import { getCurrentAccount } from "@/lib/account"

/**
 * The signed-in tenant, resolved once per request.
 *
 * Under Cache Components the shell is assembled from several independent
 * Suspense boundaries — the identity block, the user menu, each nav count —
 * and every one of them needs the same row. `cache()` is what keeps that from
 * becoming four round trips: React dedupes the call within a single request,
 * so the boundaries stream independently while sharing one query.
 *
 * Redirecting from in here rather than returning null is deliberate. Every
 * caller is a component that cannot render anything meaningful without an
 * account, so there is no branch worth giving them.
 */
export const requireShell = cache(async (): Promise<ShellContext> => {
  const account = await getCurrentAccount()

  if (account === null) {
    redirect("/sign-in")
  }

  const shell = await getShellContext(account.accountId, account.userId)

  if (shell === null) {
    // The session resolved to an account whose row is gone — a deleted tenant
    // holding a live cookie. Signed out is the honest reading.
    redirect("/sign-in")
  }

  return shell
})
