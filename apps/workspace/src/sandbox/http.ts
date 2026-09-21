import {
  hashSandboxControllerProof,
  SANDBOX_CONTROLLER_HEADER,
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
  const raw = await request.text()
  if (Buffer.byteLength(raw, "utf8") > maximumBytes) {
    return {
      ok: false,
      response: sandboxProblem(
        413,
        "request_too_large",
        "The Sandbox request is too large."
      ),
    }
  }

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
