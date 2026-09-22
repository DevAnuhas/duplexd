import { noStoreJson, requireWorkspaceSession } from "@/lib/workspace-mutation"
import { sandboxLifecycle } from "@/sandbox/lifecycle"
import { sandboxProblem } from "@/sandbox/http"

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const session = await requireWorkspaceSession()
  if (!session.ok) return session.response
  const { id } = await params
  const attempt = await sandboxLifecycle.status({
    accountId: session.account.accountId,
    attemptId: id,
  })
  return attempt === null
    ? sandboxProblem(404, "attempt_not_found", "The attempt was not found.")
    : noStoreJson({ attempt })
}
