'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { archiveAssistantAction } from '@/app/actions';

export function ArchiveButton({ assistantId }: { assistantId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  /**
   * Inside a transition, for the reason spelled out in `key-manager.tsx`: a
   * bare `router.refresh()` after a server action does not commit the new
   * render, so the row stayed in the list after archiving. Same shape, same
   * fix — and this path, like revoke, changes no local state, so there was
   * nothing to mask it.
   */
  const [, startTransition] = useTransition();

  /**
   * `busy` was set and never cleared, on any path.
   *
   * On success that is invisible, because the refresh removes the row this
   * button lives in. On a rejected action — an expired session, a database
   * that went away — the button stayed disabled with nothing said, so the
   * customer saw a dead control and no reason. Clearing it in `finally` covers
   * both, and the failure says so rather than looking like a no-op.
   */
  function onArchive() {
    setBusy(true);
    setFailed(false);

    // The action call itself goes inside the transition — see the note in
    // key-manager.tsx. Wrapping only the refresh leaves React nowhere to apply
    // the tree revalidatePath sends back, and the row stays in the list.
    startTransition(async () => {
      try {
        await archiveAssistantAction(assistantId);
        router.refresh();
      } catch {
        setFailed(true);
      } finally {
        setBusy(false);
      }
    });
  }

  return (
    <>
      <button type="button" disabled={busy} onClick={onArchive}>
        Archive
      </button>
      {failed ? (
        <span role="alert">
          {' '}
          Could not archive that assistant. Nothing was changed — try again.
        </span>
      ) : null}
    </>
  );
}
