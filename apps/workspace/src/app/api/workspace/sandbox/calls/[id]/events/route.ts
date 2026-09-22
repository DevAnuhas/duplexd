import { noStoreJson, requireWorkspaceSession } from "@/lib/workspace-mutation"
import { getSandboxEventPage } from "@/sandbox/evidence"
import { sandboxProblem } from "@/sandbox/http"

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const session = await requireWorkspaceSession()
  if (!session.ok) return session.response
  const result = await getSandboxEventPage(
    session.account.accountId,
    (await params).id,
    new URL(request.url).searchParams.get("after")
  )
  return result === null
    ? sandboxProblem(404, "call_not_found", "The call was not found.")
    : result === "invalid_cursor"
      ? sandboxProblem(400, "invalid_cursor", "The cursor is invalid.")
      : noStoreJson(result)
}
