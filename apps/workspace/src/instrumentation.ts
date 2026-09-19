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
 * customer who saves a secret.
 *
 * **Throwing here is not enough, and an earlier version of this file only
 * threw.** Next catches it: the process stays alive, keeps the port bound, and
 * answers every request with a bare 500. To anything watching the port — a Fly
 * health check, a supervisor, a load balancer — that machine looks healthy
 * while serving nothing. A process that cannot do its job should stop holding
 * the socket, so this exits and lets the platform report a failed release.
 */
export function register(): void {
  try {
    requireDatabaseUrl();
    requireAuthSecret();
    requireAuthUrl();
    requireEncryptionKey();
  } catch (error) {
    console.error(
      `[startup] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
