'use client';

import { Archive } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { archiveAssistantAction } from '@/app/actions';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';

export function ArchiveButton({
  assistantId,
  assistantName,
}: {
  assistantId: string;
  assistantName: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [, startTransition] = useTransition();

  function onArchive() {
    setBusy(true);
    setFailed(false);
    // The action itself belongs inside the transition so its revalidated
    // server tree is committed, not only the subsequent router.refresh().
    startTransition(async () => {
      try {
        const result = await archiveAssistantAction(assistantId);
        if (!result.ok) {
          setFailed(true);
          return;
        }
        setOpen(false);
        router.refresh();
      } catch {
        setFailed(true);
      } finally {
        setBusy(false);
      }
    });
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) {
          setOpen(next);
          setFailed(false);
        }
      }}
    >
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Archive ${assistantName}`}
        >
          <Archive aria-hidden="true" />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Archive {assistantName}?</AlertDialogTitle>
          <AlertDialogDescription>
            This assistant will leave your workspace and cannot start new calls.
            Its call history stays available.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {failed && (
          <Alert variant="destructive">
            <AlertDescription>
              Could not confirm the archive. Try again or refresh to check its
              status.
            </AlertDescription>
          </Alert>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Keep assistant</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            onClick={(event) => {
              event.preventDefault();
              onArchive();
            }}
          >
            {busy ? 'Archiving…' : 'Archive assistant'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
