import {
  consumeCallCreationSlot,
  insertStartingCall,
  listCallsForAccount,
  markCallStarted,
  markCallStartFailed,
  prepareCallCreation,
} from '@/data/calls';
import {
  authenticateCustomer,
  json,
  problem,
  readJsonObject,
} from '@/control/http';
import { PipecatStartError, startPipecatSession } from '@/control/pipecat';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const auth = await authenticateCustomer(request);
  if (!auth.ok) {
    return auth.response;
  }

  const body = await readJsonObject(request);
  const assistantId = body?.assistantId;

  if (
    body === null ||
    Object.keys(body).length !== 1 ||
    typeof assistantId !== 'string' ||
    assistantId.trim() === ''
  ) {
    return problem(
      400,
      'invalid_request',
      'The request must contain exactly one non-empty assistantId.',
    );
  }

  const prepared = await prepareCallCreation(auth.accountId, assistantId);
  if (prepared.kind === 'not_found') {
    return problem(404, 'assistant_not_found', 'The assistant was not found.');
  }
  if (prepared.kind === 'invalid_config') {
    return problem(
      400,
      'invalid_request',
      `The assistant is missing required call fields: ${prepared.missing.join(', ')}.`,
    );
  }

  if (!(await consumeCallCreationSlot(auth.keyId))) {
    return problem(
      429,
      'capacity_exceeded',
      'The API key call-creation rate limit was exceeded.',
    );
  }

  const created = await insertStartingCall({
    accountId: auth.accountId,
    assistantId,
    apiKeyId: auth.keyId,
    snapshot: prepared.snapshot,
  });

  try {
    const upstream = await startPipecatSession({
      callId: created.callId,
      agentToken: created.agentToken,
    });

    await markCallStarted(created.callId, upstream);

    return json({
      callId: created.callId,
      roomUrl: upstream.dailyRoom,
      token: upstream.dailyToken,
      expiresAt: upstream.expiresAt,
    });
  } catch (error) {
    const kind =
      error instanceof PipecatStartError && error.kind === 'capacity'
        ? 'capacity_exceeded'
        : 'upstream_unavailable';

    await markCallStartFailed(created.callId, kind);
    console.warn(`[calls] start failed call=${created.callId} kind=${kind}`);

    return kind === 'capacity_exceeded'
      ? problem(429, kind, 'Pipecat Cloud has no available call capacity.')
      : problem(502, kind, 'The call provider is unavailable.');
  }
}

export async function GET(request: Request): Promise<Response> {
  const auth = await authenticateCustomer(request);
  if (!auth.ok) {
    return auth.response;
  }

  const url = new URL(request.url);
  const limitValue = url.searchParams.get('limit');
  let limit: number | undefined;

  if (limitValue !== null) {
    limit = Number(limitValue);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return problem(
        400,
        'invalid_request',
        'limit must be an integer from 1 to 100.',
      );
    }
  }

  const result = await listCallsForAccount(auth.accountId, {
    cursor: url.searchParams.get('cursor'),
    limit,
  });

  return result.kind === 'invalid_cursor'
    ? problem(400, 'invalid_request', 'The cursor is invalid.')
    : json({ calls: result.calls, nextCursor: result.nextCursor });
}
