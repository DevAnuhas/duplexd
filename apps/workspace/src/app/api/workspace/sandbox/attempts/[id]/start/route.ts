import { noStoreJson, requireWorkspaceMutation } from "@/lib/workspace-mutation"
import {
  refuseDisabledSandboxExecution,
  SANDBOX_EXECUTION_DISABLED_CODE,
} from "@/sandbox/admission"
import {
  controllerProofHashFromRequest,
  requireEmptyJsonBody,
  sandboxProblem,
} from "@/sandbox/http"

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const session = await requireWorkspaceMutation(request)
  if (!session.ok) return session.response
  const controller = controllerProofHashFromRequest(request)
  if (!controller.ok) return controller.response
  const body = await requireEmptyJsonBody(request)
  if (!body.ok) return body.response
  const { id } = await params
  const result = await refuseDisabledSandboxExecution({
    accountId: session.account.accountId,
    userId: session.account.userId,
    attemptId: id,
    controllerProofHash: controller.hash,
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
      "Only the initiating user can start this attempt."
    )
  }
  if (result.kind === "invalid_controller") {
    return sandboxProblem(
      403,
      "invalid_controller_proof",
      "The Sandbox tab controller proof is invalid."
    )
  }
  return noStoreJson(
    {
      code: SANDBOX_EXECUTION_DISABLED_CODE,
      detail:
        "Sandbox execution remains disabled until the provider and runtime safety gates pass.",
      attempt: result.attempt,
    },
    503
  )
}
