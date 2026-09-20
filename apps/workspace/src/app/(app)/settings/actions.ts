'use server';

import { revalidatePath } from 'next/cache';

import { renameAccount } from '@/data/accounts';
import { requireCurrentAccount } from '@/lib/account';

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
 */

export type RenameResult = { ok: true } | { ok: false; message: string };

/** Longer than any real organization name, short enough to stay a label. */
const MAX_NAME_LENGTH = 120;

export async function renameAccountAction(
  formData: FormData,
): Promise<RenameResult> {
  const { accountId } = await requireCurrentAccount();

  const raw = formData.get('name');
  const name = typeof raw === 'string' ? raw.trim() : '';

  if (name === '') {
    return { ok: false, message: 'An organization needs a name.' };
  }

  if (name.length > MAX_NAME_LENGTH) {
    return {
      ok: false,
      message: `Keep the name under ${MAX_NAME_LENGTH} characters.`,
    };
  }

  await renameAccount(accountId, name);

  // The name is in the sidebar and the breadcrumb of every page, not just this
  // one, so the whole shell has to re-render rather than only `/settings`.
  revalidatePath('/', 'layout');

  return { ok: true };
}
