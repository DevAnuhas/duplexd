'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { archiveAssistantAction } from '@/app/actions';

export function ArchiveButton({ assistantId }: { assistantId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await archiveAssistantAction(assistantId);
        router.refresh();
      }}
    >
      Archive
    </button>
  );
}
