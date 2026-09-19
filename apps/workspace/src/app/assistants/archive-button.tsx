'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { archiveAssistantAction } from '@/app/actions';

export function ArchiveButton({ assistantId }: { assistantId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  /**
   * `busy` was set and never cleared, on any path.
   *
   * On success that is invisible, because the refresh removes the row this
   * button lives in. On a rejected action — an expired session, a database
   * that went away — the button stayed disabled with nothing said, so the
   * customer saw a dead control and no reason. Clearing it in `finally` covers
   * both, and the failure says so rather than looking like a no-op.
   */
  async function onArchive() {
    setBusy(true);
    setFailed(false);

    try {
      await archiveAssistantAction(assistantId);
      router.refresh();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
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
