'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { mintApiKeyAction, revokeApiKeyAction } from '@/app/actions';

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
   * A rejected action must not leave the form unusable — see the same note on
   * the assistant form. Without the `finally`, a server throw left the button
   * disabled forever with nothing said.
   */
  async function onMint(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const form = event.currentTarget;

    let result: Awaited<ReturnType<typeof mintApiKeyAction>>;

    try {
      result = await mintApiKeyAction(new FormData(form));
    } catch {
      setError('Something went wrong. No key was created — try again.');
      return;
    } finally {
      setBusy(false);
    }

    if (!result.ok) {
      setError(result.issues[0]?.message ?? 'That key was not created.');
      return;
    }

    setRevealed(result.raw);
    form.reset();
    router.refresh();
  }

  return (
    <>
      {revealed !== null && (
        <section role="alert" data-testid="revealed-key">
          <h2>Copy this key now</h2>
          <p>
            This is the only time it will ever be shown. Nothing can retrieve it
            afterwards — the platform stores only a hash.
          </p>
          <code>{revealed}</code>
          <button type="button" onClick={() => setRevealed(null)}>
            I have copied it
          </button>
        </section>
      )}

      <form method="post" onSubmit={onMint}>
        <label htmlFor="keyName">Name</label>
        <input
          id="keyName"
          name="name"
          required
          placeholder="What will use this key?"
        />
        {error !== null && <p role="alert">{error}</p>}
        <button type="submit" disabled={busy}>
          Mint a key
        </button>
      </form>

      {keys.length === 0 ? (
        <p>No keys yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Prefix</th>
              <th>Created</th>
              <th>Last used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => (
              <tr key={key.id}>
                <td>{key.name}</td>
                <td>
                  <code>{key.prefix}…</code>
                </td>
                <td>{new Date(key.createdAt).toISOString()}</td>
                <td>
                  {key.lastUsedAt === null
                    ? 'never'
                    : new Date(key.lastUsedAt).toISOString()}
                </td>
                <td>
                  {key.revokedAt !== null ? (
                    'revoked'
                  ) : (
                    <button
                      type="button"
                      onClick={async () => {
                        // A rejection here was a silent no-op: the key stayed
                        // live, the row did not change, and nothing said so.
                        // Revocation failing silently is the worst of the
                        // three, because the customer believes a leaked key
                        // is dead when it is not.
                        try {
                          await revokeApiKeyAction(key.id);
                          router.refresh();
                        } catch {
                          setError(
                            `Could not revoke ${key.prefix}. It is still active — try again.`,
                          );
                        }
                      }}
                    >
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
