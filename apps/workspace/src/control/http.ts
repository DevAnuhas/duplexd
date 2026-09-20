import { markApiKeyUsed, verifyApiKey } from '@/data/api-keys';

export type ProblemCode =
  | 'invalid_api_key'
  | 'assistant_not_found'
  | 'capacity_exceeded'
  | 'upstream_unavailable'
  | 'invalid_request'
  | 'invalid_agent_token'
  | 'agent_token_expired'
  | 'call_not_found'
  | 'invalid_sweep_token'
  | 'sweep_failed';

export function problem(
  status: number,
  code: ProblemCode,
  detail: string,
): Response {
  return Response.json(
    {
      type: `https://duplexd.dev/problems/${code}`,
      title: detail,
      status,
      code,
      detail,
    },
    {
      status,
      headers: {
        'content-type': 'application/problem+json',
        'cache-control': 'no-store',
      },
    },
  );
}

export function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { 'cache-control': 'no-store' },
  });
}

export function bearerToken(request: Request): string | null {
  const value = request.headers.get('authorization');

  if (value === null) {
    return null;
  }

  const match = /^Bearer ([^\s]+)$/.exec(value);
  return match?.[1] ?? null;
}

export async function authenticateCustomer(
  request: Request,
): Promise<
  | { ok: true; accountId: string; keyId: string }
  | { ok: false; response: Response }
> {
  const token = bearerToken(request);

  if (token === null) {
    return {
      ok: false,
      response: problem(401, 'invalid_api_key', 'The API key is invalid.'),
    };
  }

  const identity = await verifyApiKey(token);

  if (identity === null) {
    return {
      ok: false,
      response: problem(401, 'invalid_api_key', 'The API key is invalid.'),
    };
  }

  await markApiKeyUsed(identity.keyId);

  return { ok: true, ...identity };
}

export async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await request.json();

    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
