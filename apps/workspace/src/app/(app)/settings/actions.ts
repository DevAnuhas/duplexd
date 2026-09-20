"use server"

import { revalidatePath } from "next/cache"

import { renameAccount } from "@/data/accounts"
import { requireCurrentAccount } from "@/lib/account"
import { rendersAsNothing, WORKSPACE_NAME_MAX_LENGTH } from "@/lib/auth-schemas"

/**
 * The account's own write surface.
 *
 * Separate from `app/actions.ts` because that file is, by its own contract,
 * every write surface for **assistants and API keys** — a finite enumerable
 * set a reviewer can check. An account rename is neither, and folding it in
 * would widen a boundary that exists to stay narrow.
 *
 * **The scope comes from the session and only from the session.** The account
 * id is read from `requireCurrentAccount()` and passed to `renameAccount`;
 * nothing in `formData` reaches the `where` clause. An action that accepted an
 * `accountId` field would be the first tenant-controlled scope parameter in
 * this codebase, and it would arrive through the one write nobody thinks to
 * review — a rename looks harmless in a diff.
 *
 * **This authenticates and does not authorize, and that is only safe today.**
 * Any session bound to the account may rename it, which is moot while
 * `users.account_id` means one user per account. The moment a membership model
 * lands, every member — including whatever the read-only role turns out to be
 * — can rename the organization through this function. Add the role check
 * here at the same time as the model, not after.
 */

export type RenameResult = { ok: true } | { ok: false; message: string }

/** Shared with the signup hook and the form schema — see `auth-schemas.ts`. */
const MAX_NAME_LENGTH = WORKSPACE_NAME_MAX_LENGTH

export async function renameAccountAction(
  formData: FormData
): Promise<RenameResult> {
  const { accountId } = await requireCurrentAccount()

  const raw = formData.get("name")
  const name = typeof raw === "string" ? raw.trim() : ""

  /*
    `rendersAsNothing` rather than a local regex: the signup hook and the form
    schema apply the same rule to this column, and when this guard lived only
    here the signup endpoint accepted zero-width names that this action
    refused.

    Rejected rather than silently kept: an authenticated edit should be told it
    did nothing.
  */
  if (rendersAsNothing(name)) {
    return { ok: false, message: "An organization needs a name." }
  }

  if (name.length > MAX_NAME_LENGTH) {
    return {
      ok: false,
      message: `Keep the name under ${MAX_NAME_LENGTH} characters.`,
    }
  }

  await renameAccount(accountId, name)

  // The name is in the sidebar and the breadcrumb of every page, not just this
  // one, so the whole shell has to re-render rather than only `/settings`.
  revalidatePath("/", "layout")

  return { ok: true }
}
