'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition, type FormEvent } from 'react';

import { mintApiKeyAction, revokeApiKeyAction } from '@/app/actions';
import { CopyButton } from '@/components/copy-button';
import { Alert, AlertDescription } from '@/components/ui/alert';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
  const [, startTransition] = useTransition();

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

  /**
   * A rejected action must not leave the form unusable — see the same note on
   * the assistant form. Without the `finally`, a server throw left the button
   * disabled forever with nothing said.
   */
  async function onMint(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const form = event.currentTarget;

    const data = new FormData(form);

    withRefresh(async () => {
      try {
        const result = await mintApiKeyAction(data);

        if (!result.ok) {
          setError(result.issues[0]?.message ?? 'That key was not created.');
          return;
        }

        setRevealed(result.raw);
        form.reset();
      } catch {
        setError('Something went wrong. No key was created — try again.');
      } finally {
        setBusy(false);
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
              <Button>I have saved it</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <form
        method="post"
        onSubmit={onMint}
        className="flex flex-col gap-3 rounded-lg border bg-card p-4 sm:flex-row sm:items-end"
      >
        <div className="min-w-0 flex-1 space-y-2">
          <Label htmlFor="keyName">Key name</Label>
          <Input
            id="keyName"
            name="name"
            required
            placeholder="Production backend"
            autoComplete="off"
          />
        </div>
        <Button type="submit" disabled={busy}>
          {busy ? 'Minting…' : 'Mint a key'}
        </Button>
      </form>

      {error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

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
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        // A rejection here was a silent no-op: the key stayed
                        // live, the row did not change, and nothing said so.
                        // Revocation failing silently is the worst of the
                        // three, because the customer believes a leaked key
                        // is dead when it is not.
                        withRefresh(async () => {
                          try {
                            setError(null);
                            await revokeApiKeyAction(key.id);
                          } catch {
                            setError(
                              `Could not revoke ${key.prefix}. It is still active — try again.`,
                            );
                          }
                        });
                      }}
                    >
                      Revoke
                    </Button>
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
