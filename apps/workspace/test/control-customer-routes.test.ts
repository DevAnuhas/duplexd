import { randomUUID } from 'node:crypto';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SignedUpUser } from './helpers/auth.ts';

const requestHeaders = { current: new Headers() };

vi.mock('next/headers', () => ({
  headers: async () => requestHeaders.current,
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

const provider = vi.hoisted(() => ({ start: vi.fn() }));

vi.mock('@/control/pipecat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/control/pipecat')>();

  return { ...actual, startPipecatSession: provider.start };
});

const { POST: createCall } = await import('@/app/v1/calls/route');
const { GET: readCall } = await import('@/app/v1/calls/[id]/route');
const { GET: fetchAgentConfig } = await import(
  '@/app/v1/agent/calls/[id]/config/route'
);
const { POST: postAgentEvents } = await import(
  '@/app/v1/agent/calls/[id]/events/route'
);
const { createAssistantAction } = await import('@/app/actions');
const { createAssistant: createAssistantRecord, listAssistantsForAccount } =
  await import('@/data/assistants');
const { mintApiKey } = await import('@/data/api-keys');
const { closeDb } = await import('@/db/client');
const { PipecatStartError } = await import('@/control/pipecat');
const { CALL_RATE_LIMIT, CALL_RATE_WINDOW_MS } = await import(
  '@/control/constants'
);
const { signUpNewAccount } = await import('./helpers/auth.ts');
const {
  COMPLETE_ASSISTANT_FIELDS,
  assistantFormData,
  bearer,
  expectProblem,
  providerToken,
} = await import('./helpers/control.ts');
const { withTestPool } = await import('./helpers/database.ts');
const { isDatabaseConfigured } = await import('./helpers/environment.ts');

type Account = SignedUpUser;

const describeDatabase = describe.skipIf(!isDatabaseConfigured());

const providerExpiry = Math.floor(Date.now() / 1_000) + 86_400;
const dailyToken = providerToken(providerExpiry);

beforeEach(() => {
  provider.start.mockReset();
  provider.start.mockResolvedValue({
    sessionId: 'test-provider-session',
    dailyRoom: 'https://daily.example.invalid/test-room',
    dailyToken,
    expiresAt: new Date(providerExpiry * 1_000).toISOString(),
  });
});

afterAll(async () => {
  await closeDb();
});

async function createAssistant(
  account: Account,
  overrides: Record<string, string | undefined> = {},
): Promise<string> {
  const name = overrides.name ?? `route assistant ${randomUUID()}`;
  requestHeaders.current = new Headers({ cookie: account.cookie });

  const result = await createAssistantAction(
    assistantFormData({ ...overrides, name }),
  );
  expect(result).toStrictEqual({ ok: true, assistantId: expect.any(String) });

  const row = (await listAssistantsForAccount(account.accountId)).find(
    (assistant) => assistant.name === name,
  );
  expect(row, 'the P03 create action reported success without a row').toBeDefined();

  return row!.id;
}

async function createKey(account: Account): Promise<{ id: string; raw: string }> {
  const key = await mintApiKey(account.accountId, `route key ${randomUUID()}`, account.userId);
  return { id: key.id, raw: key.raw };
}

function createRequest(
  body: unknown,
  key?: string,
  extraHeaders: Record<string, string> = {},
): Request {
  return new Request('http://localhost:3000/v1/calls', {
    method: 'POST',
    headers: key === undefined
      ? new Headers({ 'content-type': 'application/json', ...extraHeaders })
      : new Headers({ ...Object.fromEntries(bearer(key)), ...extraHeaders }),
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function countCalls(accountId?: string): Promise<number> {
  return withTestPool(async (pool) => {
    const { rows } = await pool.query<{ hits: string }>(
      accountId === undefined
        ? 'SELECT count(*)::text AS hits FROM calls'
        : 'SELECT count(*)::text AS hits FROM calls WHERE account_id = $1',
      accountId === undefined ? [] : [accountId],
    );
    return Number(rows[0]?.hits ?? 0);
  });
}

describeDatabase('customer call creation authentication and ownership', () => {
  it('updates last_used_at for a live key and debounces the next write', async () => {
    const account = await signUpNewAccount();
    const assistantId = await createAssistant(account);
    const key = await createKey(account);

    expect(await keyLastUsedAt(key.id)).toBeNull();
    expect((await createCall(createRequest({ assistantId }, key.raw))).status).toBe(200);
    const firstUse = await keyLastUsedAt(key.id);
    expect(firstUse).not.toBeNull();

    expect((await createCall(createRequest({ assistantId }, key.raw))).status).toBe(200);
    expect(await keyLastUsedAt(key.id)).toBe(firstUse);
  });

  it.each([
    ['a missing Authorization header', undefined],
    ['a non-Bearer header', 'Basic definitely-not-a-key'],
    ['a malformed bearer value', 'Bearer dk_live_bad value'],
  ])('rejects %s without provider work or a call row', async (_label, authorization) => {
    const account = await signUpNewAccount();
    const assistantId = await createAssistant(account);
    const key = await createKey(account);
    const before = await countCalls(account.accountId);
    const request = createRequest(
      { assistantId },
      undefined,
      authorization === undefined ? {} : { authorization },
    );

    const response = await createCall(request);

    await expectProblem(response, 401, 'invalid_api_key');
    expect(provider.start).not.toHaveBeenCalled();
    expect(await countCalls(account.accountId)).toBe(before);

    // Accept control through the same route: auth failure must not mean the
    // handler simply refuses everything.
    expect((await createCall(createRequest({ assistantId }, key.raw))).status).toBe(200);
    expect(provider.start).toHaveBeenCalledTimes(1);
  });

  it('returns 404 for another real account’s assistant, with no side effect', async () => {
    const [accountA, accountB] = await Promise.all([
      signUpNewAccount(),
      signUpNewAccount(),
    ]);
    const ownAssistantId = await createAssistant(accountA);
    const otherAssistantId = await createAssistant(accountB);
    const key = await createKey(accountA);
    const before = await countCalls(accountA.accountId);

    const refused = await createCall(createRequest({ assistantId: otherAssistantId }, key.raw));

    await expectProblem(refused, 404, 'assistant_not_found');
    expect(provider.start).not.toHaveBeenCalled();
    expect(await countCalls(accountA.accountId)).toBe(before);
    expect((await createCall(createRequest({ assistantId: ownAssistantId }, key.raw))).status)
      .toBe(200);
    expect(provider.start).toHaveBeenCalledTimes(1);
  });

  it('rejects a revoked key and accepts a live key through the same credential path', async () => {
    const account = await signUpNewAccount();
    const assistantId = await createAssistant(account);
    const revoked = await createKey(account);
    const live = await createKey(account);
    await withTestPool(async (pool) => {
      await pool.query('UPDATE api_keys SET revoked_at = now() WHERE id = $1', [revoked.id]);
    });
    const before = await countCalls(account.accountId);

    await expectProblem(
      await createCall(createRequest({ assistantId }, revoked.raw)),
      401,
      'invalid_api_key',
    );
    expect(provider.start).not.toHaveBeenCalled();
    expect(await countCalls(account.accountId)).toBe(before);

    expect((await createCall(createRequest({ assistantId }, live.raw))).status).toBe(200);
    expect(provider.start).toHaveBeenCalledTimes(1);
  });

  it('maps a key deleted after authentication to invalid_api_key instead of a 500', async () => {
    const account = await signUpNewAccount();
    const assistantId = await createAssistant(account);
    const key = await createKey(account);
    const before = await countCalls(account.accountId);

    // Deterministically reproduce the database error from the real race: a
    // hard delete can commit after verifyApiKey succeeds but before the rate
    // limiter or starting-call insert checks its API-key foreign key.
    await withTestPool(async (pool) => {
      await pool.query(`
        CREATE OR REPLACE FUNCTION test_raise_deleted_api_key_fk()
        RETURNS trigger LANGUAGE plpgsql AS $fn$
        BEGIN
          RAISE EXCEPTION 'synthetic deleted-key race' USING ERRCODE = '23503';
        END
        $fn$;
        DROP TRIGGER IF EXISTS test_deleted_api_key_fk ON call_rate_limits;
        CREATE TRIGGER test_deleted_api_key_fk
          BEFORE INSERT ON call_rate_limits
          FOR EACH ROW EXECUTE FUNCTION test_raise_deleted_api_key_fk();
      `);
    });

    try {
      const response = await createCall(
        createRequest({ assistantId }, key.raw),
      );
      const body = await expectProblem(response, 401, 'invalid_api_key');

      expect(body.detail).toBe('The API key is invalid.');
      expect(body.detail).not.toContain(key.raw);
      expect(provider.start).not.toHaveBeenCalled();
      expect(await countCalls(account.accountId)).toBe(before);
    } finally {
      await withTestPool(async (pool) => {
        await pool.query(`
          DROP TRIGGER IF EXISTS test_deleted_api_key_fk ON call_rate_limits;
          DROP FUNCTION IF EXISTS test_raise_deleted_api_key_fk();
        `);
      });
    }

    // The trigger only creates the race error. Removing it proves this route
    // still accepts the same otherwise-valid request.
    expect(
      (await createCall(createRequest({ assistantId }, key.raw))).status,
    ).toBe(200);
    expect(provider.start).toHaveBeenCalledTimes(1);
  });

  it('names all eight missing runtime fields for an assistant saved with only a name', async () => {
    const account = await signUpNewAccount();
    const name = `incomplete assistant ${randomUUID()}`;
    const form = new FormData();
    form.set('name', name);
    requestHeaders.current = new Headers({ cookie: account.cookie });
    expect(await createAssistantAction(form)).toStrictEqual({
      ok: true,
      assistantId: expect.any(String),
    });
    const incomplete = (await listAssistantsForAccount(account.accountId)).find(
      (assistant) => assistant.name === name,
    );
    expect(incomplete).toBeDefined();
    const key = await createKey(account);
    const before = await countCalls(account.accountId);

    const response = await createCall(
      createRequest({ assistantId: incomplete!.id }, key.raw),
    );
    const problem = await expectProblem(response, 400, 'invalid_request');

    for (const field of [
      'voice',
      'instructions',
      'backendModel',
      'backendInstructions',
      'serverUrl',
      'serverSecret',
      'accentStyle',
      'waitingBehavior',
    ]) {
      expect(problem.detail, `the response omitted missing field ${field}`).toContain(field);
    }
    expect(provider.start).not.toHaveBeenCalled();
    expect(await countCalls(account.accountId)).toBe(before);

    const completeAssistantId = await createAssistant(account);
    expect(
      (await createCall(createRequest({ assistantId: completeAssistantId }, key.raw))).status,
    ).toBe(200);
  });

  it('accepts empty accentStyle and waitingBehavior with tools empty', async () => {
    const account = await signUpNewAccount();
    const assistant = await createAssistantRecord(account.accountId, {
      name: `empty optional strings ${randomUUID()}`,
      voice: COMPLETE_ASSISTANT_FIELDS.voice,
      accentStyle: '',
      instructions: COMPLETE_ASSISTANT_FIELDS.instructions,
      backendInstructions: COMPLETE_ASSISTANT_FIELDS.backendInstructions,
      backendModel: COMPLETE_ASSISTANT_FIELDS.backendModel,
      waitingBehavior: '',
      serverUrl: COMPLETE_ASSISTANT_FIELDS.serverUrl,
      serverSecret: COMPLETE_ASSISTANT_FIELDS.serverSecret,
      tools: [],
    });
    const key = await createKey(account);

    const response = await createCall(
      createRequest({ assistantId: assistant.id }, key.raw),
    );

    expect(response.status).toBe(200);
    expect(provider.start).toHaveBeenCalledTimes(1);
  });
});

async function keyLastUsedAt(keyId: string): Promise<string | null> {
  return withTestPool(async (pool) => {
    const { rows } = await pool.query<{ last_used_at: string | null }>(
      'SELECT last_used_at::text FROM api_keys WHERE id = $1',
      [keyId],
    );
    return rows[0]?.last_used_at ?? null;
  });
}

describeDatabase('customer call creation persistence and upstream outcomes', () => {
  it('persists the full starting snapshot before invoking the provider', async () => {
    const account = await signUpNewAccount();
    const assistantId = await createAssistant(account);
    const key = await createKey(account);
    let observedAgentToken = '';

    provider.start.mockImplementationOnce(async (input: {
      callId: string;
      agentToken: string;
    }) => {
      observedAgentToken = input.agentToken;
      const row = await withTestPool(async (pool) => {
        const { rows } = await pool.query<{
          state: string;
          assistant_snapshot: Record<string, unknown>;
          agent_token_hash: string;
        }>(
          `SELECT state, assistant_snapshot, agent_token_hash
           FROM calls WHERE id = $1`,
          [input.callId],
        );
        return rows[0];
      });

      expect(row, 'the provider ran before the starting row existed').toBeDefined();
      expect(row?.state).toBe('starting');
      const publicRuntimeFields = Object.fromEntries(
        Object.entries(COMPLETE_ASSISTANT_FIELDS).filter(
          ([field]) => field !== 'serverSecret',
        ),
      );
      expect(row?.assistant_snapshot).toMatchObject({
        assistantId,
        ...publicRuntimeFields,
      });
      expect(JSON.stringify(row?.assistant_snapshot)).not.toContain(
        COMPLETE_ASSISTANT_FIELDS.serverSecret,
      );
      expect(row?.agent_token_hash).not.toBe(input.agentToken);
      expect(row?.agent_token_hash).toMatch(/^[a-f0-9]{64}$/);

      return {
        sessionId: 'provider-session-distinctive',
        dailyRoom: 'https://daily.example.invalid/distinctive-room',
        dailyToken,
        expiresAt: new Date(providerExpiry * 1_000).toISOString(),
      };
    });

    const response = await createCall(createRequest({ assistantId }, key.raw));
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(Object.keys(body).sort()).toStrictEqual([
      'callId',
      'expiresAt',
      'roomUrl',
      'token',
    ]);
    expect(body.roomUrl).toBe('https://daily.example.invalid/distinctive-room');
    expect(body.token).toBe(dailyToken);
    expect(body.token).not.toBe(observedAgentToken);
    expect(body.expiresAt).toBe(new Date(providerExpiry * 1_000).toISOString());
    expect(new Date(String(body.expiresAt)).getTime()).toBeGreaterThan(Date.now());
  });

  it.each([
    ['capacity', 429, 'capacity_exceeded'],
    ['unavailable', 502, 'upstream_unavailable'],
  ] as const)(
    'marks the inserted row failed for an upstream %s error',
    async (kind, status, code) => {
      const account = await signUpNewAccount();
      const assistantId = await createAssistant(account);
      const key = await createKey(account);
      provider.start.mockRejectedValueOnce(new PipecatStartError(kind));

      const response = await createCall(createRequest({ assistantId }, key.raw));
      const problem = await expectProblem(response, status, code);

      expect(provider.start).toHaveBeenCalledTimes(1);
      expect(problem.detail).not.toContain('provider-secret-body');
      const rows = await withTestPool(async (pool) => {
        const result = await pool.query<{ state: string; ended_reason: string | null }>(
          `SELECT state, ended_reason FROM calls
           WHERE account_id = $1 AND assistant_id = $2
           ORDER BY created_at DESC LIMIT 1`,
          [account.accountId, assistantId],
        );
        return result.rows;
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.state).toBe('failed');
      expect(rows[0]?.ended_reason).not.toBeNull();
    },
  );

  it.each([
    ['non-JSON', 'not json at all'],
    ['non-object JSON', JSON.stringify(['wrong'])],
    ['missing assistantId', JSON.stringify({})],
    ['non-string assistantId', JSON.stringify({ assistantId: 7 })],
  ])('rejects a malformed request (%s) before provider work', async (_label, body) => {
    const account = await signUpNewAccount();
    const key = await createKey(account);
    const before = await countCalls(account.accountId);

    await expectProblem(
      await createCall(createRequest(body, key.raw)),
      400,
      'invalid_request',
    );
    expect(provider.start).not.toHaveBeenCalled();
    expect(await countCalls(account.accountId)).toBe(before);

    const assistantId = await createAssistant(account);
    expect((await createCall(createRequest({ assistantId }, key.raw))).status).toBe(200);
  });

  it('limits one key before provider work while a different key still succeeds', async () => {
    const account = await signUpNewAccount();
    const assistantId = await createAssistant(account);
    const limitedKey = await createKey(account);
    const controlKey = await createKey(account);

    expect(
      (await createCall(createRequest({ assistantId }, limitedKey.raw))).status,
    ).toBe(200);
    expect(provider.start).toHaveBeenCalledTimes(1);

    // Put this key at the limit in both the current and immediately following
    // windows. A Neon-backed run can cross a minute boundary between requests;
    // preconditioning both windows keeps this test about the handler's rule,
    // not about where wall-clock time happened to fall during the loop.
    const currentWindow = Math.floor(Date.now() / CALL_RATE_WINDOW_MS)
      * CALL_RATE_WINDOW_MS;
    await withTestPool(async (pool) => {
      await pool.query(
        `INSERT INTO call_rate_limits (api_key_id, window_started_at, count)
         VALUES ($1, $2, $4), ($1, $3, $4)
         ON CONFLICT (api_key_id, window_started_at)
         DO UPDATE SET count = EXCLUDED.count`,
        [
          limitedKey.id,
          new Date(currentWindow),
          new Date(currentWindow + CALL_RATE_WINDOW_MS),
          CALL_RATE_LIMIT,
        ],
      );
    });
    const beforeRejected = await countCalls(account.accountId);

    const limited = await expectProblem(
      await createCall(createRequest({ assistantId }, limitedKey.raw)),
      429,
      'capacity_exceeded',
    );
    expect(limited.detail).toContain('rate limit');
    expect(limited.detail).not.toContain(limitedKey.raw);
    expect(provider.start).toHaveBeenCalledTimes(1);
    expect(await countCalls(account.accountId)).toBe(beforeRejected);

    expect(
      (await createCall(createRequest({ assistantId }, controlKey.raw))).status,
    ).toBe(200);
    expect(provider.start).toHaveBeenCalledTimes(2);
  });

  it('sweeps all planted canaries from logs, errors, headers, and public responses', async () => {
    const logs: string[] = [];
    const logSpies = [
      vi.spyOn(console, 'info').mockImplementation((...values) => {
        logs.push(values.map(String).join(' '));
      }),
      vi.spyOn(console, 'warn').mockImplementation((...values) => {
        logs.push(values.map(String).join(' '));
      }),
      vi.spyOn(console, 'error').mockImplementation((...values) => {
        logs.push(values.map(String).join(' '));
      }),
    ];

    try {
      const account = await signUpNewAccount();
      const webhookPlaintext = `webhook-plaintext-${randomUUID()}`;
      const assistantId = await createAssistant(account, {
        serverSecret: webhookPlaintext,
      });
      const key = await createKey(account);
      const transcript = `transcript-text-${randomUUID()}`;
      const upstreamBody = `upstream-response-${randomUUID()}`;
      let agentToken = '';
      provider.start.mockImplementationOnce(async (input: { agentToken: string }) => {
        agentToken = input.agentToken;
        return {
          sessionId: 'canary-session',
          dailyRoom: 'https://daily.example.invalid/canary-room',
          dailyToken,
          expiresAt: new Date(providerExpiry * 1_000).toISOString(),
        };
      });

      const createdResponse = await createCall(
        createRequest({ assistantId }, key.raw),
      );
      const createdText = await createdResponse.text();
      const callId = (JSON.parse(createdText) as { callId: string }).callId;
      expect(agentToken).not.toBe('');

      // The authorized config response necessarily carries the webhook secret
      // to the agent. Exercise it, but do not misclassify that intended private
      // channel as a public-response leak.
      expect(
        (
          await fetchAgentConfig(
            new Request(`http://localhost:3000/v1/agent/calls/${callId}/config`, {
              headers: bearer(agentToken),
            }),
            { params: Promise.resolve({ id: callId }) },
          )
        ).status,
      ).toBe(200);
      const eventResponse = await postAgentEvents(
        new Request(`http://localhost:3000/v1/agent/calls/${callId}/events`, {
          method: 'POST',
          headers: bearer(agentToken),
          body: JSON.stringify({
            events: [
              {
                seq: 1,
                at: '2026-09-20T10:00:00.123456+00:00',
                type: 'transcript_user',
                payload: { text: transcript },
              },
            ],
          }),
        }),
        { params: Promise.resolve({ id: callId }) },
      );
      expect(eventResponse.status).toBe(200);

      const publicResponse = await readCall(
        new Request(`http://localhost:3000/v1/calls/${callId}`, {
          headers: bearer(key.raw),
        }),
        { params: Promise.resolve({ id: callId }) },
      );
      const publicText = await publicResponse.text();
      const ciphertext = await withTestPool(async (pool) => {
        const { rows } = await pool.query<{ ciphertext: string }>(
          `SELECT assistant_snapshot->>'serverSecretCiphertext' AS ciphertext
           FROM calls WHERE id = $1`,
          [callId],
        );
        return rows[0]!.ciphertext;
      });

      provider.start.mockRejectedValueOnce(new Error(upstreamBody));
      const failedResponse = await createCall(
        createRequest({ assistantId }, key.raw),
      );
      const failedText = await failedResponse.text();
      expect(failedResponse.status).toBe(502);

      const captured = [
        ...logs,
        createdText,
        JSON.stringify([...createdResponse.headers]),
        publicText,
        JSON.stringify([...publicResponse.headers]),
        await eventResponse.text(),
        JSON.stringify([...eventResponse.headers]),
        failedText,
        JSON.stringify([...failedResponse.headers]),
      ].join('\n');

      // Positive sentinel first: an empty or disconnected capture cannot pass.
      expect(captured).toContain(callId);
      expect(captured).toContain('count=1');
      for (const canary of [
        key.raw,
        agentToken,
        webhookPlaintext,
        ciphertext,
        transcript,
        upstreamBody,
      ]) {
        expect(captured, `public capture leaked ${canary.split('-')[0]}`).not.toContain(canary);
      }
    } finally {
      for (const spy of logSpies) spy.mockRestore();
    }
  });
});
