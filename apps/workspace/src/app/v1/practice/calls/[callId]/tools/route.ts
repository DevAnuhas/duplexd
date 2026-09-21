import {
  invokePracticeSample,
  MAX_PRACTICE_WEBHOOK_BYTES,
} from "@/practice/samples"

function problem(status: number, code: string, detail: string): Response {
  return Response.json(
    { code, detail },
    { status, headers: { "cache-control": "no-store" } }
  )
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ callId: string }> }
): Promise<Response> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]
  if (contentType !== "application/json") {
    return problem(415, "invalid_content_type", "Expected application/json.")
  }
  const contentLength = Number(request.headers.get("content-length"))
  if (
    Number.isFinite(contentLength) &&
    contentLength > MAX_PRACTICE_WEBHOOK_BYTES
  ) {
    return problem(413, "request_too_large", "The webhook body is too large.")
  }

  const rawBody = new Uint8Array(await request.arrayBuffer())
  if (rawBody.byteLength > MAX_PRACTICE_WEBHOOK_BYTES) {
    return problem(413, "request_too_large", "The webhook body is too large.")
  }

  const { callId } = await params
  const result = await invokePracticeSample({
    callId,
    rawBody,
    headers: {
      signature: request.headers.get("duplexd-signature"),
      callId: request.headers.get("duplexd-call-id"),
      assistantId: request.headers.get("duplexd-assistant-id"),
      invocationId: request.headers.get("duplexd-invocation-id"),
    },
  })

  if (result.kind === "ok") {
    return Response.json(result.body, {
      status: result.status,
      headers: { "cache-control": "no-store" },
    })
  }

  switch (result.kind) {
    case "invalid_signature":
      return problem(401, "invalid_practice_signature", result.detail)
    case "not_found":
      return problem(404, "practice_call_not_found", result.detail)
    case "not_active":
      return problem(409, "practice_call_not_active", result.detail)
    case "conflict":
      return problem(409, "practice_invocation_conflict", result.detail)
    case "limit_exceeded":
      return problem(429, "practice_invocation_limit", result.detail)
    case "invalid_request":
      return problem(400, "invalid_practice_request", result.detail)
  }
}
