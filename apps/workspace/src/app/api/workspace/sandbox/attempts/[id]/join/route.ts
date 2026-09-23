import { noStoreJson } from "@/lib/workspace-mutation"
import {
  requireSandboxBrowserOwner,
  sandboxExecutionProblem,
} from "@/sandbox/http"
import { sandboxLifecycle } from "@/sandbox/provider"

/**
 * Returns the browser's room-scoped media credential for a started attempt.
 *
 * The credential is decrypted per request and never cached, logged or put in a
 * URL — the client hands it straight to the Daily adapter. A caller who is not
 * the initiating user in the owning tab gets a refusal before the ciphertext
 * is touched at all.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const browser = await requireSandboxBrowserOwner(request, params)
  if (!browser.ok) return browser.response

  const result = await sandboxLifecycle().join(browser.owner)
  if (result.kind !== "ok") return sandboxExecutionProblem(result, "join")

  return noStoreJson({ join: result.join })
}
