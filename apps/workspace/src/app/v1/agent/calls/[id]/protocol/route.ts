import { handleAgentNegotiation } from "@/sandbox/evidence-http"

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  return handleAgentNegotiation(request, (await params).id)
}
