import { AGENT_EVENT_TYPES, AGENT_SEQUENCE_LIMIT } from '@/control/constants';
import { agentAuthProblem, requireAgentToken } from '@/control/agent-http';
import { json, problem, readJsonObject } from '@/control/http';
import { ingestAgentEvents, type AgentEventInput } from '@/data/calls';


const acceptedTypes = new Set(AGENT_EVENT_TYPES);
const RFC3339_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

function parseEvents(
  body: Record<string, unknown>,
): { ok: true; events: AgentEventInput[] } | { ok: false; detail: string } {
  if (Object.keys(body).length !== 1 || !Array.isArray(body.events)) {
    return { ok: false, detail: 'The request must contain an events array.' };
  }

  const events: AgentEventInput[] = [];
  const seen = new Set<number>();

  for (const value of body.events) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, detail: 'Every event must be an object.' };
    }
    const event = value as Record<string, unknown>;

    if (!Number.isInteger(event.seq) || Number(event.seq) <= 0) {
      return { ok: false, detail: 'Event seq must be a positive integer.' };
    }
    const seq = Number(event.seq);
    if (seq >= AGENT_SEQUENCE_LIMIT) {
      return {
        ok: false,
        detail: `Agent event seq must be below ${AGENT_SEQUENCE_LIMIT}; the reserved range belongs to the platform.`,
      };
    }
    if (seen.has(seq)) {
      return { ok: false, detail: 'An event batch cannot repeat a seq.' };
    }
    seen.add(seq);

    if (typeof event.at !== 'string' || !RFC3339_TIMESTAMP.test(event.at)) {
      return { ok: false, detail: 'Event at must be an RFC 3339 timestamp.' };
    }
    const at = new Date(event.at);
    if (Number.isNaN(at.getTime())) {
      return { ok: false, detail: 'Event at must be an RFC 3339 timestamp.' };
    }
    if (typeof event.type !== 'string' || !acceptedTypes.has(event.type)) {
      return { ok: false, detail: 'Event type is not supported.' };
    }
    if (
      event.payload === null ||
      typeof event.payload !== 'object' ||
      Array.isArray(event.payload)
    ) {
      return { ok: false, detail: 'Event payload must be an object.' };
    }

    events.push({
      seq,
      at: event.at,
      type: event.type,
      payload: event.payload as Record<string, unknown>,
    });
  }

  return { ok: true, events };
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const credential = requireAgentToken(request);
  if (!credential.ok) {
    return credential.response;
  }

  const body = await readJsonObject(request);
  if (body === null) {
    return problem(
      400,
      'invalid_request',
      'The request body must be a JSON object.',
    );
  }
  const parsed = parseEvents(body);
  if (!parsed.ok) {
    return problem(400, 'invalid_request', parsed.detail);
  }

  const { id } = await params;
  const result = await ingestAgentEvents(id, credential.token, parsed.events);

  if (result.kind === 'ok') {
    if (parsed.events.length > 0) {
      console.info(`[calls] events call=${id} count=${parsed.events.length}`);
    }
    return json({ accepted: parsed.events.length });
  }
  if (
    result.kind === 'not_found' ||
    result.kind === 'invalid_token' ||
    result.kind === 'expired_token'
  ) {
    return agentAuthProblem(result.kind);
  }

  return problem(409, 'invalid_request', 'The call is not accepting events.');
}
