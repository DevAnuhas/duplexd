import { noStoreJson } from "@/lib/workspace-mutation"
import { getSandboxAttemptForAccount } from "@/sandbox/admission"
import {
  requireSandboxBrowserOwner,
  sandboxExecutionProblem,
  sandboxProblem,
} from "@/sandbox/http"
import { sandboxLifecycle } from "@/sandbox/provider"

/**
 * Renews the presence lease that proves the browser controller is still alive.
 * A ready Practice call may continue while the tab is hidden.
 *
 * **The attempt travels with the renewal, and that is load-bearing.** Nothing
 * else polls it once audio is connected, and the browser holds the call open
 * only while `readyAt` is set or the 120-second startup deadline has not
 * passed. Without the attempt here, a perfectly healthy call is torn down by
 * the client two minutes after dispatch, because the browser never sees the
 * readiness the server recorded. The renewal already runs every 15 seconds
 * against the same locked row, so carrying the projection costs one more read
 * and removes the need for a second polling loop.
 *
 * `serverTime` comes from the projection rather than a second clock read: the
 * client measures the remaining lease as `presenceExpiresAt - serverTime`, and
 * two reads either side of a slow transaction would shorten it for no reason.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const browser = await requireSandboxBrowserOwner(request, params)
  if (!browser.ok) return browser.response

  const probe =
    process.env.VERCEL_ENV === "preview" &&
    process.env.VERCEL_GIT_COMMIT_REF ===
      "feat/82-practice-background-continuity"
  const rawSequence = request.headers.get("x-duplexd-practice-probe-seq")
  const sequence = probe && rawSequence !== null ? Number(rawSequence) : null
  const safeSequence =
    sequence !== null && Number.isSafeInteger(sequence) && sequence > 0
      ? sequence
      : null
  const result = await sandboxLifecycle().presence({
    ...browser.owner,
    probeSequence: safeSequence,
  })
  if (result.kind !== "ok") {
    if (probe)
      console.info(
        "[practice-background-probe]",
        JSON.stringify({
          attemptId: browser.owner.attemptId,
          sequence: safeSequence,
          outcome: result.kind,
        })
      )
    return sandboxExecutionProblem(result, "renew")
  }

  const attempt = await getSandboxAttemptForAccount({
    accountId: browser.owner.accountId,
    attemptId: browser.owner.attemptId,
  })

  return attempt === null
    ? sandboxProblem(404, "attempt_not_found", "The attempt was not found.")
    : noStoreJson({
        serverTime: attempt.serverTime,
        presenceExpiresAt: result.presenceExpiresAt,
        attempt,
      })
}
