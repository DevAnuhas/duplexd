import { isTest as betterAuthIsTest } from "@better-auth/core/env"

import {
  requireAuthSecret,
  requireAuthUrl,
  requireDatabaseUrl,
  requireEncryptionKey,
  requirePipecatApiKey,
} from "@/db/env"

/**
 * Validates the five app-wide runtime prerequisites at initialization.
 *
 * Next calls `register()` when a function or the standalone verification
 * server initializes — not during `next build` — so the deployment build does
 * not need a database or key.
 *
 * Checking at first use instead would be too late in the way that matters.
 * `ASSISTANT_SECRET_KEY` is read only when an assistant's webhook secret is
 * encrypted or decrypted, which P02 has no user-facing path to, so a deploy
 * missing it would boot green, serve every page, and fail in P03 on the first
 * customer who saves a secret.
 *
 * `CALL_SWEEP_TOKEN` is deliberately not a sixth global prerequisite. The
 * membership criterion here is discovery latency, not importance: the sweep
 * scheduler exercises its token within minutes, its route refuses when the
 * token is absent, and read-time staleness keeps customer-visible state correct
 * even while persistence is degraded. Taking down unrelated functions would
 * turn that safe degradation into a platform outage.
 *
 * On the old long-lived Fly server, throwing here was insufficient: Next
 * caught the error while the process kept a healthy-looking port bound, so the
 * process had to exit. Vercel functions have no durable application socket to
 * surrender. Letting the registration error propagate makes every affected
 * function invocation fail closed instead of terminating a shared serverless
 * worker. The production-server test proves both halves: a complete
 * environment serves every route class, and a missing variable makes every
 * route class return 500 while naming only the variable in server logs.
 */
export async function register(): Promise<void> {
  requireDatabaseUrl()
  requireAuthSecret()
  requireAuthUrl()
  requireEncryptionKey()
  requirePipecatApiKey()

  if (process.env.NODE_ENV === "production" && betterAuthIsTest()) {
    throw new Error(
      "Better Auth resolved production as test mode. Remove TEST and test-runner markers from the runtime environment."
    )
  }

  if (process.env.NODE_ENV === "production") {
    console.info(
      "[startup] Better Auth production mode verified (isTest=false)."
    )
  }
}
