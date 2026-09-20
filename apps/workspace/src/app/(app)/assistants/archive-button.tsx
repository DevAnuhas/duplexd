'use client';

import { Archive } from '@phosphor-icons/react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { archiveAssistantAction } from '@/app/actions';
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
  const [, startTransition] = useTransition();

  function onArchive() {
    setBusy(true);
    // The action itself belongs inside the transition so its revalidated
    // server tree is committed, not only the subsequent router.refresh().
    startTransition(async () => {
      try {
        const result = await archiveAssistantAction(assistantId);
        if (!result.ok) {
          toast.error(
            'Could not confirm the archive. Try again or refresh to check its status.',
          );
          return;
        }
        setOpen(false);
        toast.success('Assistant archived');
        router.refresh();
      } catch {
        toast.error(
          'Could not confirm the archive. Try again or refresh to check its status.',
        );
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
        }
      }}
    >
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-11"
          aria-label={`Archive ${assistantName}`}
        >
          <Archive weight="regular" className="size-4" aria-hidden="true" />
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
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy} className="min-h-11">
            Keep assistant
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            className="min-h-11"
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
