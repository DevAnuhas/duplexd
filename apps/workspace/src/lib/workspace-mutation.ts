import { createHmac } from "node:crypto"

import { getCurrentAccount, type CurrentAccount } from "@/lib/account"
import { requireAuthSecret, resolveAuthBaseUrl } from "@/db/env"
import { secretsMatch } from "@/lib/crypto"

export const WORKSPACE_CSRF_HEADER = "x-duplexd-csrf"
const TOKEN_VERSION = "workspace-csrf-v1"

export function workspaceCsrfToken(sessionId: string): string {
  return createHmac("sha256", requireAuthSecret())
    .update(`${TOKEN_VERSION}:${sessionId}`)
    .digest("base64url")
}

function allowedOrigin(origin: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  if (parsed.origin !== origin) return false

  const configured = resolveAuthBaseUrl()
  if (typeof configured === "string") {
    return parsed.origin === new URL(configured).origin
  }
  return (
    parsed.protocol === `${configured.protocol}:` &&
    configured.allowedHosts.includes(parsed.host)
  )
}

function workspaceProblem(
  status: number,
  code: string,
  detail: string
): Response {
  return Response.json(
    { code, detail },
    {
      status,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/problem+json",
      },
    }
  )
}

export async function requireWorkspaceSession(): Promise<
  { ok: true; account: CurrentAccount } | { ok: false; response: Response }
> {
  const account = await getCurrentAccount()
  return account === null
    ? {
        ok: false,
        response: workspaceProblem(
          401,
          "workspace_session_required",
          "An authenticated workspace session is required."
        ),
      }
    : { ok: true, account }
}

/** Shared fail-closed guard for every workspace JSON mutation. */
export async function requireWorkspaceMutation(
  request: Request
): Promise<
  { ok: true; account: CurrentAccount } | { ok: false; response: Response }
> {
  const session = await requireWorkspaceSession()
  if (!session.ok) return session

  const origin = request.headers.get("origin")
  if (origin === null || !allowedOrigin(origin)) {
    return {
      ok: false,
      response: workspaceProblem(
        403,
        "invalid_origin",
        "The request origin is not allowed."
      ),
    }
  }

  const fetchSite = request.headers.get("sec-fetch-site")
  if (fetchSite !== null && fetchSite !== "same-origin") {
    return {
      ok: false,
      response: workspaceProblem(
        403,
        "invalid_origin",
        "The request must be same-origin."
      ),
    }
  }

  if (
    request.headers.get("content-type")?.split(";", 1)[0] !== "application/json"
  ) {
    return {
      ok: false,
      response: workspaceProblem(
        415,
        "invalid_content_type",
        "The request must use application/json."
      ),
    }
  }

  const supplied = request.headers.get(WORKSPACE_CSRF_HEADER)
  const expected = workspaceCsrfToken(session.account.sessionId)
  if (supplied === null || !secretsMatch(supplied, expected)) {
    return {
      ok: false,
      response: workspaceProblem(
        403,
        "invalid_csrf_token",
        "The workspace request token is invalid."
      ),
    }
  }

  return session
}

export function noStoreJson(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  })
}
