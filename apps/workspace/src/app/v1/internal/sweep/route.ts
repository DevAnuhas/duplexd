import { authenticateSweep } from "@/control/sweep-auth"
import { json, problem } from "@/control/http"
import { sweepStaleCalls } from "@/data/calls"
import { readCallSweepToken } from "@/db/env"

export async function handleSweepRequest(
  request: Request,
  now = new Date()
): Promise<Response> {
  const decision = authenticateSweep(
    request.headers.get("authorization"),
    readCallSweepToken()
  )

  if (!decision.ok) {
    if (decision.reason === "sweep_not_configured") {
      console.error(
        "[sweep] CALL_SWEEP_TOKEN is not configured; request refused."
      )
    }
    return problem(401, "invalid_sweep_token", "The sweep token is invalid.")
  }

  try {
    return json(await sweepStaleCalls(now))
  } catch {
    console.error("[sweep] failed")
    return problem(500, "sweep_failed", "The call sweep failed.")
  }
}

export async function POST(request: Request): Promise<Response> {
  return handleSweepRequest(request)
}
