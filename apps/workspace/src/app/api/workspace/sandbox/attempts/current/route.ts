import { noStoreJson, requireWorkspaceSession } from "@/lib/workspace-mutation"
import { getCurrentSandboxAttempt } from "@/sandbox/admission"

export async function GET(): Promise<Response> {
  const session = await requireWorkspaceSession()
  if (!session.ok) return session.response
  const attempt = await getCurrentSandboxAttempt({
    accountId: session.account.accountId,
    userId: session.account.userId,
  })
  return noStoreJson({ attempt })
}
