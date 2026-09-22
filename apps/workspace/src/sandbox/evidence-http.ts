import { requireAgentToken } from "@/control/agent-http"
import { noStoreJson } from "@/lib/workspace-mutation"
import { readBoundedJsonObject, sandboxProblem } from "./http"
import {
  negotiateAgentProtocol,
  parseSandboxCompletion,
  parseSandboxEvents,
  sandboxEvidenceService,
} from "./evidence"
import {
  SANDBOX_PROTOCOL,
  SANDBOX_PROTOCOL_HEADER,
  SANDBOX_SESSION_HEADER,
  SANDBOX_BOOT_HEADER,
  SANDBOX_EVIDENCE_LIMITS,
  validSandboxIdentity,
} from "./protocol"

export async function handleAgentNegotiation(
  request: Request,
  callId: string
): Promise<Response> {
  const auth = requireAgentToken(request)
  if (!auth.ok) return auth.response
  const protocol = await negotiateAgentProtocol(callId, auth.token)
  return protocol
    ? noStoreJson({ protocol })
    : sandboxProblem(404, "call_not_found", "The call was not found.")
}

export async function handleSandboxEvidence(
  request: Request,
  callId: string,
  operation: "events" | "complete"
): Promise<Response> {
  if (request.headers.get(SANDBOX_PROTOCOL_HEADER) !== SANDBOX_PROTOCOL)
    return sandboxProblem(
      426,
      "unsupported_protocol",
      "Sandbox requires sandbox-v1."
    )
  const auth = requireAgentToken(request)
  if (!auth.ok) return auth.response
  const sessionId = request.headers.get(SANDBOX_SESSION_HEADER)
  const bootId = request.headers.get(SANDBOX_BOOT_HEADER)
  if (!validSandboxIdentity(sessionId) || !validSandboxIdentity(bootId))
    return sandboxProblem(
      400,
      "invalid_owner",
      "The runtime identity is invalid."
    )
  const input = { callId, token: auth.token, owner: { sessionId, bootId } }
  const body = await readBoundedJsonObject(
    request,
    operation === "events" ? SANDBOX_EVIDENCE_LIMITS.batchBytes : 4096
  )
  const json =
    request.headers.get("content-type")?.split(";")[0]?.trim() ===
    "application/json"
  const events =
    body.ok && json && operation === "events"
      ? parseSandboxEvents(body.value)
      : null
  const completion =
    body.ok && json && operation === "complete"
      ? parseSandboxCompletion(body.value)
      : null
  const result = events
    ? await sandboxEvidenceService.ingest(input, events)
    : completion
      ? await sandboxEvidenceService.complete(input, completion)
      : await sandboxEvidenceService.invalid(input)
  if (result.kind === "ok") return noStoreJson(result.ack)
  const status =
    result.kind === "not_found"
      ? 404
      : result.kind === "expired"
        ? 410
        : result.kind === "rate_limited"
          ? 429
          : result.kind === "invalid_request"
            ? body.ok
              ? 400
              : body.response.status
            : 409
  return sandboxProblem(
    status,
    result.kind,
    "The Sandbox evidence request cannot be accepted."
  )
}
