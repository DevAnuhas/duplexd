import { noStoreJson, requireWorkspaceMutation } from "@/lib/workspace-mutation"
import { SANDBOX_EXECUTION_DISABLED_CODE } from "@/sandbox/admission"
import { requireEmptyJsonBody, sandboxProblem } from "@/sandbox/http"
import { sandboxLifecycle } from "@/sandbox/provider"

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const session = await requireWorkspaceMutation(request)
  if (!session.ok) return session.response
  const body = await requireEmptyJsonBody(request)
  if (!body.ok) return body.response
  const { id } = await params
  const result = await sandboxLifecycle().stop({
    accountId: session.account.accountId,
    userId: session.account.userId,
    attemptId: id,
  })
  if (result.kind === "not_found") {
    return sandboxProblem(
      404,
      "attempt_not_found",
      "The attempt was not found."
    )
  }
  if (result.kind === "not_owner") {
    return sandboxProblem(
      403,
      "attempt_not_owned",
      "Only the initiating user can stop this attempt."
    )
  }
  if (result.kind === "provider_cleanup_disabled") {
    return noStoreJson(
      {
        code: SANDBOX_EXECUTION_DISABLED_CODE,
        detail:
          "Provider cleanup is unavailable while Sandbox execution is disabled.",
        attempt: result.attempt,
      },
      503
    )
  }
  return noStoreJson({ attempt: result.attempt })
}
