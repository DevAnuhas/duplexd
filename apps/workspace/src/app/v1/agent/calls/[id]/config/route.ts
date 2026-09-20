import { agentAuthProblem, requireAgentToken } from '@/control/agent-http';
import { json, problem } from '@/control/http';
import { claimAgentConfig } from '@/data/calls';


export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const credential = requireAgentToken(request);
  if (!credential.ok) {
    return credential.response;
  }

  const { id } = await params;
  const result = await claimAgentConfig(id, credential.token);

  if (result.kind === 'ok') {
    return json(result.config);
  }
  if (
    result.kind === 'not_found' ||
    result.kind === 'invalid_token' ||
    result.kind === 'expired_token'
  ) {
    return agentAuthProblem(result.kind);
  }
  if (result.kind === 'already_claimed') {
    return problem(
      409,
      'invalid_request',
      'The call configuration has already been claimed.',
    );
  }

  return problem(
    500,
    'invalid_request',
    'The call configuration is unavailable.',
  );
}
