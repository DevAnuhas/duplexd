import {
  requireAuthSecret,
  requireAuthUrl,
  requireDatabaseUrl,
  requireEncryptionKey,
} from '@/db/env';

/**
 * Validates every environment variable the app reads, once, at server start.
 *
 * Next calls `register()` when the server boots — not during `next build` — so
 * this makes `.env.example`'s promise true without making the image build need
 * a database or a key.
 *
 * Checking at first use instead would be too late in the way that matters.
 * `ASSISTANT_SECRET_KEY` is read only when an assistant's webhook secret is
 * encrypted or decrypted, which P02 has no user-facing path to, so a deploy
 * missing it would boot green, serve every page, and fail in P03 on the first
 * customer who saves a secret. A process that cannot do its job should refuse
 * to start rather than wait to be asked.
 *
 * Each getter throws naming its own variable, so the first missing one is the
 * one reported.
 */
export function register(): void {
  requireDatabaseUrl();
  requireAuthSecret();
  requireAuthUrl();
  requireEncryptionKey();
}
