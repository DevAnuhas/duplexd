import {
  noStoreJson,
  requireWorkspaceMutation,
  requireWorkspaceSession,
} from "@/lib/workspace-mutation"
import {
  getAssistantSamplesForAccount,
  MAX_SAMPLE_DEFINITIONS_BYTES,
  saveAssistantSamplesForAccount,
} from "@/practice/samples"

function problem(status: number, code: string, detail: string): Response {
  return noStoreJson({ code, detail }, status)
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const session = await requireWorkspaceSession()
  if (!session.ok) return session.response
  const { id } = await params
  const samples = await getAssistantSamplesForAccount(
    session.account.accountId,
    id
  )
  return samples === null
    ? problem(404, "assistant_not_found", "The assistant was not found.")
    : noStoreJson(samples)
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const session = await requireWorkspaceMutation(request)
  if (!session.ok) return session.response

  const contentLength = Number(request.headers.get("content-length"))
  if (
    Number.isFinite(contentLength) &&
    contentLength > MAX_SAMPLE_DEFINITIONS_BYTES + 4_096
  ) {
    return problem(413, "request_too_large", "The sample request is too large.")
  }
  const raw = await request.text()
  if (Buffer.byteLength(raw, "utf8") > MAX_SAMPLE_DEFINITIONS_BYTES + 4_096) {
    return problem(413, "request_too_large", "The sample request is too large.")
  }

  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return problem(400, "invalid_request", "The request body is invalid JSON.")
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return problem(
      400,
      "invalid_request",
      "The request body must be an object."
    )
  }
  const record = body as Record<string, unknown>
  if (
    Object.keys(record).some(
      (key) => !["expectedRevision", "definitions"].includes(key)
    ) ||
    !Number.isSafeInteger(record.expectedRevision) ||
    Number(record.expectedRevision) < 0
  ) {
    return problem(
      400,
      "invalid_request",
      "The request requires expectedRevision and definitions."
    )
  }

  const { id } = await params
  const saved = await saveAssistantSamplesForAccount(
    session.account.accountId,
    id,
    Number(record.expectedRevision),
    record.definitions
  )
  switch (saved.kind) {
    case "not_found":
      return problem(404, "assistant_not_found", "The assistant was not found.")
    case "conflict":
      return noStoreJson(
        {
          code: "sample_revision_conflict",
          detail: "Samples changed in another tab.",
          currentRevision: saved.currentRevision,
        },
        409
      )
    case "invalid":
      return noStoreJson(
        {
          code: "invalid_samples",
          detail: "The sample definitions are invalid.",
          issues: saved.issues,
        },
        400
      )
    case "saved":
      return noStoreJson(saved.samples)
  }
}
