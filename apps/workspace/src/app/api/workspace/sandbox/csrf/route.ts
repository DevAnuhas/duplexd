import {
  noStoreJson,
  requireWorkspaceSession,
  workspaceCsrfToken,
} from "@/lib/workspace-mutation"

export async function GET(): Promise<Response> {
  const session = await requireWorkspaceSession()
  if (!session.ok) return session.response
  return noStoreJson({ token: workspaceCsrfToken(session.account.sessionId) })
}
