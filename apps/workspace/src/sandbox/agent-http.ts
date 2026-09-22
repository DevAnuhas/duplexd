import { requireAgentToken } from "@/control/agent-http"
import { requireAuthUrl } from "@/db/env"
import { noStoreJson } from "@/lib/workspace-mutation"

import { readBoundedJsonObject, sandboxProblem } from "./http"
import { sandboxLifecycle } from "./lifecycle"
import {
  SANDBOX_BOOT_HEADER,
  SANDBOX_PROTOCOL,
  SANDBOX_PROTOCOL_HEADER,
  SANDBOX_SESSION_HEADER,
  validSandboxIdentity,
} from "./protocol"

/** New payloads are selected explicitly, never appended to the legacy config. */
export async function handleSandboxAgentRequest(
  request: Request,
  callId: string,
  operation: "register" | "config" | "control"
): Promise<Response> {
  if (request.headers.get(SANDBOX_PROTOCOL_HEADER) !== SANDBOX_PROTOCOL)
    return sandboxProblem(
      426,
      "unsupported_protocol",
      "Sandbox requires sandbox-v1."
    )
  const credential = requireAgentToken(request)
  if (!credential.ok) return credential.response
  let sessionId: unknown = request.headers.get(SANDBOX_SESSION_HEADER)
  let bootId: unknown = request.headers.get(SANDBOX_BOOT_HEADER)
  if (operation === "register") {
    if (
      request.headers.get("content-type")?.split(";")[0]?.trim() !==
      "application/json"
    )
      return sandboxProblem(
        415,
        "invalid_request",
        "Registration requires JSON."
      )
    const body = await readBoundedJsonObject(request, 4096)
    if (!body.ok) return body.response
    if (Object.keys(body.value).length !== 2)
      return sandboxProblem(
        400,
        "invalid_request",
        "Registration requires sessionId and bootId."
      )
    sessionId = body.value.sessionId
    bootId = body.value.bootId
  }
  if (!validSandboxIdentity(sessionId) || !validSandboxIdentity(bootId))
    return sandboxProblem(
      400,
      "invalid_owner",
      "The runtime identity is invalid."
    )
  const input = {
    callId,
    token: credential.token,
    owner: { sessionId, bootId },
  }
  const result =
    operation === "register"
      ? await sandboxLifecycle.register(input)
      : operation === "config"
        ? await sandboxLifecycle.claim(input, requireAuthUrl())
        : await sandboxLifecycle.control(input)
  if (result.kind === "ok") {
    if ("config" in result) return noStoreJson(result.config)
    if ("control" in result)
      return noStoreJson({
        protocol: SANDBOX_PROTOCOL,
        control: result.control,
      })
    return noStoreJson({ protocol: SANDBOX_PROTOCOL, registered: true })
  }
  const status =
    result.kind === "not_found" ? 404 : result.kind === "expired" ? 410 : 409
  return sandboxProblem(
    status,
    result.kind,
    "The Sandbox runtime request cannot be accepted."
  )
}
