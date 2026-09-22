import { handleSandboxAgentRequest } from "@/sandbox/agent-http"

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  return handleSandboxAgentRequest(request, (await params).id, "register")
}
