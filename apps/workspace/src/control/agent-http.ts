import type { AgentAuthFailure } from "@/data/calls"

import { bearerToken, problem } from "./http"

export function requireAgentToken(
  request: Request
): { ok: true; token: string } | { ok: false; response: Response } {
  const token = bearerToken(request)

  return token === null
    ? {
        ok: false,
        response: problem(
          401,
          "invalid_agent_token",
          "The agent credential is invalid."
        ),
      }
    : { ok: true, token }
}

export function agentAuthProblem(kind: AgentAuthFailure): Response {
  switch (kind) {
    case "not_found":
      return problem(404, "call_not_found", "The call was not found.")
    case "invalid_token":
      return problem(
        401,
        "invalid_agent_token",
        "The agent credential is invalid."
      )
    case "expired_token":
      return problem(
        401,
        "agent_token_expired",
        "The agent credential is no longer usable."
      )
  }
}
