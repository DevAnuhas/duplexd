'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { mintApiKeyAction, revokeApiKeyAction } from '@/app/actions';
import { CopyButton } from '@/components/copy-button';
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  apiKeyNameSchema,
  type ApiKeyNameValues,
} from '@/lib/api-key-schemas';

type KeyRow = {
  id: string;
  name: string;
  prefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
};

/**
 * Minting, revealing once, and revoking.
 *
 * The reveal is held in component state and nowhere else. Not the URL, not
 * `history.state`, not `localStorage` or `sessionStorage` — each of those
 * would outlive the one view, and two of them survive the tab closing. A
 * refresh re-renders from the server, which has only the prefix and a hash,
 * so the key is gone. That is the behaviour, not a promise about it: there is
 * no code path that could fetch it back.
 */
export function KeyManager({ keys }: { keys: KeyRow[] }) {
  const router = useRouter();
  const [revealed, setRevealed] = useState<string | null>(null);
  const form = useForm<ApiKeyNameValues>({
    resolver: zodResolver(apiKeyNameSchema),
    defaultValues: { name: '' },
  });

  /**
   * **`router.refresh()` has to run inside a transition or the new server
   * render is never committed.**
   *
   * Revoking a key wrote the revocation and the list did not change: the
   * `Revoke` button stayed, nothing said `revoked`, and further clicks were
   * silent no-ops against an already-revoked key. Enforcement was correct
   * throughout — the row really was revoked — which is the part that makes
   * this dangerous rather than merely untidy. Someone killing a leaked
   * credential got no confirmation it was dead, and the reasonable reading of
   * a button that does nothing is that it did not work.
   *
   * Minting hid the same defect. It calls `setRevealed`, so its own state
   * change re-renders the component and the list looks updated; the refresh
   * was just as inert there. Only the path with no local state change exposed
   * it — the same shape as a test that passes for the wrong reason.
   */
  const [pending, startTransition] = useTransition();

  /**
   * Runs a server action **inside a transition**.
   *
   * This is the part that matters, and wrapping only `router.refresh()` was
   * not enough — I tried that first and watched it fail against a real
   * server. When an action is invoked outside a transition, React has nowhere
   * to apply the re-rendered tree that `revalidatePath` sends back with the
   * action's response, so the new server render is discarded and the list
   * keeps its old props. The action itself has to be the thing inside the
   * transition.
   *
   * `router.refresh()` afterwards is belt-and-braces for any path that does
   * not revalidate.
   */
  function withRefresh(run: () => Promise<void>) {
    startTransition(async () => {
      await run();
      router.refresh();
    });
  }

  function onMint(values: ApiKeyNameValues) {
    withRefresh(async () => {
      try {
        const data = new FormData();
        data.set('name', values.name);
        const result = await mintApiKeyAction(data);

        if (!result.ok) {
          const message =
            result.issues[0]?.message ?? 'That key was not created.';
          form.setError('name', { message });
          toast.error(message);
          return;
        }

        setRevealed(result.raw);
        form.reset();
        toast.success('API key minted');
      } catch {
        toast.error('Something went wrong. No key was created — try again.');
      }
    });
  }

  return (
    <div className="space-y-6">
      <Dialog
        open={revealed !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRevealed(null);
          }
        }}
      >
        <DialogContent
          data-testid="revealed-key"
          className="border-primary/30 sm:max-w-xl"
          showCloseButton={false}
        >
          <DialogHeader>
            <DialogTitle>Copy this key now</DialogTitle>
            <DialogDescription>
              This is the only time it will ever be shown. Nothing can retrieve
              it afterwards — the platform stores only a hash.
            </DialogDescription>
          </DialogHeader>
          {revealed !== null && (
            <div className="flex items-start gap-2 rounded-lg border bg-primary/5 p-3">
              <span className="min-w-0 flex-1 break-all text-sm leading-relaxed">
                {revealed}
              </span>
              <CopyButton
                value={revealed}
                label="Copy key"
                successLabel="Key copied"
              />
            </div>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button className="h-11">I have saved it</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <form
        method="post"
        noValidate
        onSubmit={form.handleSubmit(onMint)}
        className="rounded-lg border bg-card p-4"
      >
        <FieldGroup className="gap-4">
          <Controller
            name="name"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid} className="gap-2">
                <FieldLabel htmlFor={field.name}>Key name</FieldLabel>
                <Input
                  {...field}
                  id={field.name}
                  aria-invalid={fieldState.invalid}
                  maxLength={80}
                  placeholder="Production backend"
                  autoComplete="off"
                  className="h-11"
                />
                <FieldDescription>
                  Use a name that identifies the project or environment.
                </FieldDescription>
                <FieldError errors={[fieldState.error]} />
              </Field>
            )}
          />
          <Button
            type="submit"
            disabled={pending}
            aria-busy={pending}
            className="h-11 self-start"
          >
            {pending ? 'Minting…' : 'Mint a key'}
          </Button>
        </FieldGroup>
      </form>

      {keys.length === 0 ? (
        <div className="border-y py-10">
          <h2 className="text-lg font-medium">No API keys yet</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Mint a key to start calls from your app.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead>Name</TableHead>
                <TableHead>Prefix</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
            {keys.map((key) => (
              <TableRow key={key.id}>
                <TableCell className="font-medium">{key.name}</TableCell>
                <TableCell className="tabular-nums">{key.prefix}…</TableCell>
                <TableCell>{formatDate(key.createdAt)}</TableCell>
                <TableCell>
                  {key.lastUsedAt === null
                    ? 'Never'
                    : formatDate(key.lastUsedAt)}
                </TableCell>
                <TableCell>
                  <Badge
                    variant="outline"
                    className={
                      key.revokedAt === null
                        ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                        : 'bg-secondary text-secondary-foreground'
                    }
                  >
                    {key.revokedAt === null ? 'Active' : 'Revoked'}
                  </Badge>
                </TableCell>
                <TableCell className="text-right">
                  {key.revokedAt === null && (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          className="h-11"
                        >
                          Revoke
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>
                            Revoke {key.name}?
                          </AlertDialogTitle>
                          <AlertDialogDescription>
                            Projects using {key.prefix}… will no longer be able
                            to start calls. Existing call history is kept.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel className="h-11">
                            Keep active
                          </AlertDialogCancel>
                          <AlertDialogAction
                            variant="destructive"
                            className="h-11"
                            onClick={() => {
                              withRefresh(async () => {
                                try {
                                  await revokeApiKeyAction(key.id);
                                  toast.success(`${key.name} revoked`);
                                } catch {
                                  toast.error(
                                    `Could not revoke ${key.prefix}. It is still active — try again.`,
                                  );
                                }
                              });
                            }}
                          >
                            Revoke key
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  )}
                </TableCell>
              </TableRow>
            ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

const dateTime = new Intl.DateTimeFormat('en', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'UTC',
  timeZoneName: 'short',
});

function formatDate(value: Date): string {
  return dateTime.format(new Date(value));
}
