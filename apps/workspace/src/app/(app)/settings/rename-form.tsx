'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition, type FormEvent } from 'react';

import { renameAccountAction } from './actions';
import { Button } from '@/components/ui/button';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';

/**
 * Renaming the organization.
 *
 * The input is **uncontrolled** with a `defaultValue`, matching the assistant
 * form: a rejected save leaves exactly what the customer typed, rather than
 * snapping back to the stored value and discarding their edit.
 *
 * There is deliberately **no hidden account id**. The action reads the account
 * from the session; a field here would be decoration at best, and at worst the
 * thing a future refactor decides to trust.
 */
export function RenameForm({ currentName }: { currentName: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  /**
   * The action runs **inside a transition**, not merely the refresh.
   *
   * This is the same defect the API key manager documents: invoked outside a
   * transition, React has nowhere to apply the re-rendered tree that
   * `revalidatePath` returns with the action's response, so the new server
   * render is discarded. Here that would mean the sidebar and breadcrumb keep
   * the old name after a successful rename — the rename appearing not to work
   * when it did.
   */
  const [pending, startTransition] = useTransition();

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const data = new FormData(event.currentTarget);

    setError(null);
    setSaved(false);

    startTransition(async () => {
      try {
        const result = await renameAccountAction(data);

        if (!result.ok) {
          setError(result.message);
          return;
        }

        setSaved(true);
        router.refresh();
      } catch {
        // A rejected action must not leave the form silently inert. The
        // message is generic on purpose: it reaches a customer who can do
        // nothing with server detail.
        setError('Something went wrong. The name was not changed — try again.');
      }
    });
  }

  return (
    <form method="post" onSubmit={onSubmit}>
      <Field data-invalid={error === null ? undefined : true}>
        <FieldLabel htmlFor="accountName">Organization name</FieldLabel>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id="accountName"
            name="name"
            defaultValue={currentName}
            required
            maxLength={120}
            className="max-w-sm"
            aria-invalid={error === null ? undefined : true}
          />
          <Button type="submit" disabled={pending}>
            {pending ? 'Saving…' : 'Save'}
          </Button>
          {saved && !pending && (
            <span className="text-muted-foreground text-sm">Saved</span>
          )}
        </div>
        {error !== null && <FieldError role="alert">{error}</FieldError>}
      </Field>
    </form>
  );
}
