import { noStoreJson, requireWorkspaceSession } from "@/lib/workspace-mutation"
import { sandboxLifecycle } from "@/sandbox/lifecycle"

export async function GET(): Promise<Response> {
  const session = await requireWorkspaceSession()
  if (!session.ok) return session.response
  const attempt = await sandboxLifecycle.current({
    accountId: session.account.accountId,
    userId: session.account.userId,
  })
  return noStoreJson({ attempt })
}
