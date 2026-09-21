import { noStoreJson, requireWorkspaceMutation } from "@/lib/workspace-mutation"
import {
  parseSandboxPrepareInput,
  prepareSandboxAttempt,
  SANDBOX_PREPARE_BODY_LIMIT,
} from "@/sandbox/admission"
import {
  controllerProofHashFromRequest,
  readBoundedJsonObject,
  sandboxProblem,
} from "@/sandbox/http"

export async function POST(request: Request): Promise<Response> {
  const session = await requireWorkspaceMutation(request)
  if (!session.ok) return session.response
  const controller = controllerProofHashFromRequest(request)
  if (!controller.ok) return controller.response
  const body = await readBoundedJsonObject(request, SANDBOX_PREPARE_BODY_LIMIT)
  if (!body.ok) return body.response
  const parsed = parseSandboxPrepareInput(body.value)
  if (!parsed.ok) {
    return sandboxProblem(
      400,
      "invalid_request",
      "The Sandbox attempt request is invalid."
    )
  }

  const result = await prepareSandboxAttempt({
    accountId: session.account.accountId,
    userId: session.account.userId,
    controllerProofHash: controller.hash,
    request: parsed.input,
  })
  switch (result.kind) {
    case "created":
      return noStoreJson({ attempt: result.attempt }, 201)
    case "replay":
      return noStoreJson({ attempt: result.attempt })
    case "attempt_conflict":
      return sandboxProblem(
        409,
        "attempt_conflict",
        "This attempt identifier was already used with different input."
      )
    case "assistant_not_found":
      return sandboxProblem(
        404,
        "assistant_not_found",
        "The assistant was not found."
      )
    case "assistant_changed":
      return sandboxProblem(
        409,
        "assistant_changed",
        "The assistant changed before this attempt was prepared.",
        { currentRevision: result.currentRevision }
      )
    case "samples_changed":
      return sandboxProblem(
        409,
        "samples_changed",
        "The saved samples changed before this attempt was prepared.",
        { currentRevision: result.currentRevision }
      )
    case "invalid":
      return sandboxProblem(
        400,
        "invalid_sandbox_configuration",
        "The Sandbox configuration is not runnable.",
        { issues: result.issues }
      )
    case "user_slot_occupied":
      return sandboxProblem(
        409,
        "sandbox_attempt_active",
        "This user already has an unresolved Sandbox attempt.",
        { attempt: result.attempt }
      )
    case "account_capacity_exceeded":
      return sandboxProblem(
        429,
        "sandbox_account_capacity_exceeded",
        "This account has too many unresolved Sandbox attempts."
      )
    case "user_rate_exceeded":
      return sandboxProblem(
        429,
        "sandbox_user_rate_exceeded",
        "This user has prepared too many Sandbox attempts."
      )
    case "account_rate_exceeded":
      return sandboxProblem(
        429,
        "sandbox_account_rate_exceeded",
        "This account has prepared too many Sandbox attempts."
      )
  }
}
