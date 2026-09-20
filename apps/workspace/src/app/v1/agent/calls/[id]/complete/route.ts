import { AGENT_END_REASONS, type AgentEndReason } from '@/control/constants';
import { agentAuthProblem, requireAgentToken } from '@/control/agent-http';
import { json, problem, readJsonObject } from '@/control/http';
import { completeAgentCall } from '@/data/calls';


const acceptedReasons = new Set<string>(AGENT_END_REASONS);

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const credential = requireAgentToken(request);
  if (!credential.ok) {
    return credential.response;
  }

  const body = await readJsonObject(request);
  const endedReason = body?.endedReason;
  const durationSecs = body?.durationSecs;

  if (
    body === null ||
    Object.keys(body).length !== 2 ||
    typeof endedReason !== 'string' ||
    !acceptedReasons.has(endedReason) ||
    typeof durationSecs !== 'number' ||
    !Number.isFinite(durationSecs) ||
    durationSecs < 0 ||
    durationSecs > 999_999_999.999
  ) {
    return problem(
      400,
      'invalid_request',
      'Completion requires a supported endedReason and a non-negative durationSecs.',
    );
  }

  const { id } = await params;
  const result = await completeAgentCall(id, credential.token, {
    endedReason: endedReason as AgentEndReason,
    durationSecs,
  });

  if (result.kind === 'ok') {
    return json({ completed: true });
  }
  if (
    result.kind === 'not_found' ||
    result.kind === 'invalid_token' ||
    result.kind === 'expired_token'
  ) {
    return agentAuthProblem(result.kind);
  }

  return problem(409, 'invalid_request', 'The call is not active.');
}
