import { requireAuthUrl, requirePipecatApiKey } from '@/db/env';

import { PIPECAT_AGENT_NAME, PIPECAT_START_ORIGIN } from './constants';

export type PipecatStartResult = {
  sessionId: string;
  dailyRoom: string;
  dailyToken: string;
  expiresAt: string;
};

export class PipecatStartError extends Error {
  constructor(readonly kind: 'capacity' | 'unavailable') {
    super(
      kind === 'capacity'
        ? 'Pipecat capacity exceeded.'
        : 'Pipecat start failed.',
    );
  }
}

function tokenExpiry(token: string): string | null {
  const payload = token.split('.')[1];

  if (payload === undefined) {
    return null;
  }

  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    );
    const exp =
      decoded !== null && typeof decoded === 'object'
        ? (decoded as { exp?: unknown }).exp
        : undefined;

    if (
      typeof exp !== 'number' ||
      !Number.isSafeInteger(exp) ||
      exp * 1_000 <= Date.now()
    ) {
      return null;
    }

    return new Date(exp * 1_000).toISOString();
  } catch {
    return null;
  }
}

export async function startPipecatSession(
  input: { callId: string; agentToken: string },
  fetchImpl: typeof fetch = fetch,
): Promise<PipecatStartResult> {
  let response: Response;

  try {
    response = await fetchImpl(
      `${PIPECAT_START_ORIGIN}/v1/public/${PIPECAT_AGENT_NAME}/start`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${requirePipecatApiKey()}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          createDailyRoom: true,
          transport: 'daily',
          body: {
            callId: input.callId,
            apiBase: requireAuthUrl(),
            agentToken: input.agentToken,
          },
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
  } catch {
    throw new PipecatStartError('unavailable');
  }

  if (response.status === 429) {
    throw new PipecatStartError('capacity');
  }

  if (response.status !== 200) {
    throw new PipecatStartError('unavailable');
  }

  let value: unknown;

  try {
    value = await response.json();
  } catch {
    throw new PipecatStartError('unavailable');
  }

  if (value === null || typeof value !== 'object') {
    throw new PipecatStartError('unavailable');
  }

  const record = value as Record<string, unknown>;
  const sessionId = record.sessionId;
  const dailyRoom = record.dailyRoom;
  const dailyToken = record.dailyToken;

  if (
    typeof sessionId !== 'string' ||
    sessionId === '' ||
    typeof dailyRoom !== 'string' ||
    dailyRoom === '' ||
    typeof dailyToken !== 'string' ||
    dailyToken === ''
  ) {
    throw new PipecatStartError('unavailable');
  }

  const expiresAt = tokenExpiry(dailyToken);

  if (expiresAt === null) {
    throw new PipecatStartError('unavailable');
  }

  return { sessionId, dailyRoom, dailyToken, expiresAt };
}
