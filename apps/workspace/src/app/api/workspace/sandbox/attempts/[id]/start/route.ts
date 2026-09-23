import { noStoreJson } from "@/lib/workspace-mutation"
import { getSandboxAttemptForAccount } from "@/sandbox/admission"
import {
  requireSandboxBrowserOwner,
  sandboxExecutionProblem,
  sandboxProblem,
} from "@/sandbox/http"
import { sandboxLifecycle } from "@/sandbox/provider"

/**
 * Dispatches a prepared attempt to the provider.
 *
 * The response is the attempt, re-read after dispatch settles rather than
 * returned from inside it. Dispatch's own result says only whether it ran; the
 * outcome lives in the row — `starting` with a session, or `start_unknown`
 * with a stop already requested — and the browser has to see the second thing,
 * because "the request was processed" and "a call is running" are not the same
 * claim and only one of them is safe to act on.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const browser = await requireSandboxBrowserOwner(request, params)
  if (!browser.ok) return browser.response

  const result = await sandboxLifecycle().dispatch(browser.owner)
  if (result.kind !== "processed")
    return sandboxExecutionProblem(result, "start")

  const attempt = await getSandboxAttemptForAccount({
    accountId: browser.owner.accountId,
    attemptId: browser.owner.attemptId,
  })

  return attempt === null
    ? sandboxProblem(404, "attempt_not_found", "The attempt was not found.")
    : noStoreJson({ attempt })
}
