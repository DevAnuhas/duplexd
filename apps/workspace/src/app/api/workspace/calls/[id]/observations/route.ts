import {
  getCallObservationsForAccount,
  OBSERVATION_BODY_LIMIT,
  parseObservationInput,
  putCallObservation,
} from "@/data/observations"
import {
  noStoreJson,
  requireWorkspaceMutation,
  requireWorkspaceSession,
} from "@/lib/workspace-mutation"
import { readBoundedJsonObject } from "@/sandbox/http"

type Context = { params: Promise<{ id: string }> }

function problem(
  status: number,
  code: string,
  detail: string,
  extra = {}
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

export async function GET(
  _request: Request,
  { params }: Context
): Promise<Response> {
  const session = await requireWorkspaceSession()
  if (!session.ok) return session.response
  const observations = await getCallObservationsForAccount(
    session.account.accountId,
    (await params).id,
    session.account.userId
  )
  return observations === null
    ? problem(404, "call_not_found", "The call was not found.")
    : noStoreJson({ observations })
}

export async function PUT(
  request: Request,
  { params }: Context
): Promise<Response> {
  const session = await requireWorkspaceMutation(request)
  if (!session.ok) return session.response
  const body = await readBoundedJsonObject(request, OBSERVATION_BODY_LIMIT)
  if (!body.ok) {
    return body.response.status === 413
      ? problem(
          413,
          "request_too_large",
          "The observation request is too large."
        )
      : problem(400, "invalid_request", "The request body is invalid.")
  }
  const input = parseObservationInput(body.value)
  if (input === null) {
    return problem(400, "invalid_observation", "The observation is invalid.")
  }
  const result = await putCallObservation(
    session.account.accountId,
    session.account.userId,
    (await params).id,
    input
  )
  switch (result.kind) {
    case "saved":
      return noStoreJson({ observation: result.observation })
    case "conflict":
      return problem(409, "observation_conflict", "The observation changed.", {
        current: result.current,
      })
    case "not_found":
      return problem(404, "call_not_found", "The call was not found.")
  }
}
