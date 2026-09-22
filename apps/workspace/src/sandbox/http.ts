import { noStoreJson, requireWorkspaceMutation } from "@/lib/workspace-mutation"

import {
  hashSandboxControllerProof,
  SANDBOX_CONTROLLER_HEADER,
  SANDBOX_EXECUTION_DISABLED_CODE,
  type SandboxAttemptDto,
} from "./admission"

export function sandboxProblem(
  status: number,
  code: string,
  detail: string,
  extra: Record<string, unknown> = {}
): Response {
  return Response.json(
    { code, detail, ...extra },
    {
      status,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/problem+json",
      },
    }
  )
}

export async function readBoundedJsonObject(
  request: Request,
  maximumBytes: number
): Promise<
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; response: Response }
> {
  const declared = Number(request.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > maximumBytes) {
    return {
      ok: false,
      response: sandboxProblem(
        413,
        "request_too_large",
        "The Sandbox request is too large."
      ),
    }
  }

  const chunks: Uint8Array[] = []
  let totalBytes = 0
  const reader = request.body?.getReader()
  if (reader !== undefined) {
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        totalBytes += chunk.value.byteLength
        if (totalBytes > maximumBytes) {
          try {
            await reader.cancel("Sandbox request body exceeded its byte limit.")
          } catch {
            // The response contract is still 413 if the peer races cancellation.
          }
          return {
            ok: false,
            response: sandboxProblem(
              413,
              "request_too_large",
              "The Sandbox request is too large."
            ),
          }
        }
        chunks.push(chunk.value)
      }
    } finally {
      reader.releaseLock()
    }
  }

  const raw = Buffer.concat(chunks, totalBytes).toString("utf8")

  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return {
      ok: false,
      response: sandboxProblem(
        400,
        "invalid_request",
        "The request body is invalid JSON."
      ),
    }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      response: sandboxProblem(
        400,
        "invalid_request",
        "The request body must be an object."
      ),
    }
  }
  return { ok: true, value: value as Record<string, unknown> }
}

export function controllerProofHashFromRequest(
  request: Request
): { ok: true; hash: string } | { ok: false; response: Response } {
  const proof = request.headers.get(SANDBOX_CONTROLLER_HEADER)
  const hash = proof === null ? null : hashSandboxControllerProof(proof)
  return hash === null
    ? {
        ok: false,
        response: sandboxProblem(
          403,
          "invalid_controller_proof",
          "The Sandbox tab controller proof is invalid."
        ),
      }
    : { ok: true, hash }
}

export async function requireEmptyJsonBody(
  request: Request
): Promise<{ ok: true } | { ok: false; response: Response }> {
  const body = await readBoundedJsonObject(request, 4_096)
  if (!body.ok) return body
  return Object.keys(body.value).length === 0
    ? { ok: true }
    : {
        ok: false,
        response: sandboxProblem(
          400,
          "invalid_request",
          "This Sandbox request body must be empty."
        ),
      }
}

/**
 * The browser-owned preamble every execution route shares: an authenticated
 * mutation, a tab controller proof, an empty body, and the attempt id.
 *
 * Start, join and presence used to be one exported handler because all three
 * did the same thing — refuse. Now that they do three different things, the
 * part that is genuinely identical is this, and it is the part worth sharing:
 * duplicating the proof and body checks per route is how one of them
 * eventually stops checking.
 */
export async function requireSandboxBrowserOwner(
  request: Request,
  params: Promise<{ id: string }>
): Promise<
  | {
      ok: true
      owner: {
        accountId: string
        userId: string
        attemptId: string
        controllerProofHash: string
      }
    }
  | { ok: false; response: Response }
> {
  const session = await requireWorkspaceMutation(request)
  if (!session.ok) return { ok: false, response: session.response }
  const controller = controllerProofHashFromRequest(request)
  if (!controller.ok) return controller
  const body = await requireEmptyJsonBody(request)
  if (!body.ok) return body
  const { id } = await params
  return {
    ok: true,
    owner: {
      accountId: session.account.accountId,
      userId: session.account.userId,
      attemptId: id,
      controllerProofHash: controller.hash,
    },
  }
}

/**
 * The response for an execution result that is not the success this route
 * wanted. Each route checks its own success kind first, so this never has to
 * guess which kind counted as success.
 *
 * `disabled` is the configuration boundary and keeps its 503 and its attempt
 * body, so the browser can distinguish "this deployment does not do voice
 * calls" from "your attempt is no longer usable". Everything else is a
 * conflict: the attempt exists and belongs to the caller, but its state does
 * not permit the operation — `unavailable`, `expired`, `unchanged`,
 * `already_claimed`, `identity_conflict`. The `kind` is returned verbatim as
 * the code because the client maps unknown codes to a generic message anyway,
 * and an invented code would make the server log and the client disagree.
 */
export function sandboxExecutionProblem(
  result: { kind: string; attempt?: SandboxAttemptDto },
  action: "start" | "join" | "renew"
): Response {
  switch (result.kind) {
    case "not_found":
      return sandboxProblem(
        404,
        "attempt_not_found",
        "The attempt was not found."
      )
    case "not_owner":
      return sandboxProblem(
        403,
        "attempt_not_owned",
        `Only the initiating user can ${action} this attempt.`
      )
    case "invalid_controller":
      return sandboxProblem(
        403,
        "invalid_controller_proof",
        "The Sandbox tab controller proof is invalid."
      )
    case "disabled":
      return noStoreJson(
        {
          code: SANDBOX_EXECUTION_DISABLED_CODE,
          detail:
            "This deployment is not configured to run Sandbox voice calls.",
          attempt: result.attempt,
        },
        503
      )
    default:
      return sandboxProblem(
        409,
        result.kind,
        "The attempt is no longer in a state that allows this request."
      )
  }
}
