import { handleSandboxAgentRequest } from "@/sandbox/agent-http"

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  return handleSandboxAgentRequest(request, (await params).id, "control")
}
