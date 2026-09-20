import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SignedUpUser } from './helpers/auth.ts';

const requestHeaders = { current: new Headers() };

vi.mock('next/headers', () => ({
  headers: async () => requestHeaders.current,
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const provider = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock('@/control/pipecat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/control/pipecat')>();
  return { ...actual, startPipecatSession: provider.start };
});

const { POST: createCall } = await import('@/app/v1/calls/route');
const { GET: fetchConfig } = await import('@/app/v1/agent/calls/[id]/config/route');
const { POST: postEvents } = await import('@/app/v1/agent/calls/[id]/events/route');
const { POST: postComplete } = await import('@/app/v1/agent/calls/[id]/complete/route');
const { createAssistantAction, updateAssistantAction } = await import('@/app/actions');
const { ACTIVE_STALE_AFTER_MS, AGENT_EVENT_TYPES } = await import(
  '@/control/constants'
);
const { listAssistantsForAccount } = await import('@/data/assistants');
const { mintApiKey } = await import('@/data/api-keys');
const { sweepStaleCalls } = await import('@/data/calls');
const { closeDb } = await import('@/db/client');
const { signUpNewAccount } = await import('./helpers/auth.ts');
const {
  COMPLETE_ASSISTANT_FIELDS,
  FLAT_TOOL_WITH_IGNORED_KEY,
  assistantFormData,
  bearer,
  expectProblem,
  providerToken,
} = await import('./helpers/control.ts');
const { withTestPool } = await import('./helpers/database.ts');
const { isDatabaseConfigured } = await import('./helpers/environment.ts');

type Account = SignedUpUser;
type StartedCall = { callId: string; agentToken: string };

const describeDatabase = describe.skipIf(!isDatabaseConfigured());
const routeContext = (id: string) => ({ params: Promise.resolve({ id }) });
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

beforeEach(() => {
  provider.start.mockReset();
});

afterAll(async () => {
  await closeDb();
});

async function createCompleteAssistant(
  account: Account,
  overrides: Record<string, string | undefined> = {},
): Promise<string> {
  const name = overrides.name ?? `agent route assistant ${randomUUID()}`;
  requestHeaders.current = new Headers({ cookie: account.cookie });
  expect(
    await createAssistantAction(assistantFormData({ ...overrides, name })),
  ).toStrictEqual({ ok: true, assistantId: expect.any(String) });
  const assistant = (await listAssistantsForAccount(account.accountId)).find(
    (row) => row.name === name,
  );
  expect(assistant).toBeDefined();
  return assistant!.id;
}

async function startCall(
  assistantId: string,
  rawKey: string,
): Promise<StartedCall> {
  let agentToken = '';
  provider.start.mockImplementationOnce(async (input: StartedCall) => {
    agentToken = input.agentToken;
    return {
      sessionId: `session-${randomUUID()}`,
      dailyRoom: 'https://daily.example.invalid/agent-route-room',
      dailyToken: providerToken(Math.floor(Date.now() / 1_000) + 3_600),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    };
  });
  const response = await createCall(
    new Request('http://localhost:3000/v1/calls', {
      method: 'POST',
      headers: bearer(rawKey),
      body: JSON.stringify({ assistantId }),
    }),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { callId: string };
  expect(agentToken).not.toBe('');
  return { callId: body.callId, agentToken };
}

function agentRequest(
  callId: string,
  suffix: string,
  token: string,
  method: 'GET' | 'POST',
  body?: unknown,
): Request {
  return new Request(`http://localhost:3000/v1/agent/calls/${callId}/${suffix}`, {
    method,
    headers: bearer(token),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function activeCall(): Promise<StartedCall & { account: Account; assistantId: string }> {
  const account = await signUpNewAccount();
  const assistantId = await createCompleteAssistant(account);
  const key = await mintApiKey(account.accountId, 'agent route key', account.userId);
  const started = await startCall(assistantId, key.raw);
  const response = await fetchConfig(
    agentRequest(started.callId, 'config', started.agentToken, 'GET'),
    routeContext(started.callId),
  );
  expect(response.status).toBe(200);
  return { ...started, account, assistantId };
}

async function heartbeat(callId: string): Promise<string | null> {
  return withTestPool(async (pool) => {
    const { rows } = await pool.query<{ heartbeat: string | null }>(
      'SELECT last_heartbeat_at::text AS heartbeat FROM calls WHERE id = $1',
      [callId],
    );
    return rows[0]?.heartbeat ?? null;
  });
}

describeDatabase('agent configuration contract', () => {
  it('serves immutable snapshot bytes accepted by the real Python AgentConfig', async () => {
    const account = await signUpNewAccount();
    const assistantId = await createCompleteAssistant(account);
    const key = await mintApiKey(account.accountId, 'snapshot key', account.userId);
    const first = await startCall(assistantId, key.raw);

    requestHeaders.current = new Headers({ cookie: account.cookie });
    const updated = {
      voice: 'updated-voice',
      accentStyle: 'updated accent',
      instructions: 'Updated instructions.',
      backendInstructions: 'Updated backend instructions.',
      backendModel: 'updated-model',
      waitingBehavior: 'Updated wait behavior.',
      serverUrl: 'https://updated.example.invalid/tools',
      serverSecret: 'updated-synthetic-webhook-secret',
      tools: JSON.stringify([]),
    };
    expect(
      await updateAssistantAction(
        assistantId,
        assistantFormData({ name: 'updated snapshot assistant', ...updated }),
      ),
    ).toStrictEqual({ ok: true });

    const firstResponse = await fetchConfig(
      agentRequest(first.callId, 'config', first.agentToken, 'GET'),
      routeContext(first.callId),
    );
    const firstBytes = Buffer.from(await firstResponse.arrayBuffer());
    expect(firstResponse.status).toBe(200);
    const firstConfig = JSON.parse(firstBytes.toString('utf8')) as Record<string, unknown>;
    expect(firstConfig).toMatchObject({
      assistantId,
      voice: COMPLETE_ASSISTANT_FIELDS.voice,
      accentStyle: COMPLETE_ASSISTANT_FIELDS.accentStyle,
      waitingBehavior: COMPLETE_ASSISTANT_FIELDS.waitingBehavior,
      backendModel: COMPLETE_ASSISTANT_FIELDS.backendModel,
      backendInstructions: COMPLETE_ASSISTANT_FIELDS.backendInstructions,
      serverUrl: COMPLETE_ASSISTANT_FIELDS.serverUrl,
      serverSecret: COMPLETE_ASSISTANT_FIELDS.serverSecret,
      webhookTimeoutSecs: 2,
      functionCallTimeoutSecs: 5,
      delegationTimeoutSecs: 10,
    });
    expect(firstConfig.tools).toStrictEqual([
      {
        type: 'function',
        function: {
          name: FLAT_TOOL_WITH_IGNORED_KEY.name,
          description: FLAT_TOOL_WITH_IGNORED_KEY.description,
          parameters: FLAT_TOOL_WITH_IGNORED_KEY.parameters,
        },
      },
    ]);
    expect(JSON.stringify(firstConfig)).not.toContain('ignoredByAgentProjection');

    const python = spawnSync(
      'uv',
      [
        'run',
        '--directory',
        'agent',
        'python',
        '-c',
        'import json,sys; from duplexd_agent.config import AgentConfig; AgentConfig.from_response(json.load(sys.stdin))',
      ],
      { cwd: repositoryRoot, input: firstBytes, encoding: 'utf8' },
    );
    expect(
      python.status,
      `the actual route response bytes were rejected by Python AgentConfig: ${python.stderr}`,
    ).toBe(0);

    const second = await startCall(assistantId, key.raw);
    const secondResponse = await fetchConfig(
      agentRequest(second.callId, 'config', second.agentToken, 'GET'),
      routeContext(second.callId),
    );
    const secondConfig = (await secondResponse.json()) as Record<string, unknown>;
    expect(secondResponse.status).toBe(200);
    expect(secondConfig).toMatchObject({
      assistantId,
      voice: updated.voice,
      accentStyle: updated.accentStyle,
      instructions: updated.instructions,
      backendInstructions: updated.backendInstructions,
      backendModel: updated.backendModel,
      waitingBehavior: updated.waitingBehavior,
      serverUrl: updated.serverUrl,
      serverSecret: updated.serverSecret,
      tools: [],
    });
  });

  it('allows one config claim while keeping the token usable for events', async () => {
    const call = await activeCall();

    await expectProblem(
      await fetchConfig(
        agentRequest(call.callId, 'config', call.agentToken, 'GET'),
        routeContext(call.callId),
      ),
      409,
      'invalid_request',
    );
    const eventsResponse = await postEvents(
      agentRequest(call.callId, 'events', call.agentToken, 'POST', { events: [] }),
      routeContext(call.callId),
    );
    expect(eventsResponse.status).toBe(200);
  });

  it('distinguishes garbage credentials from a valid token used on another call', async () => {
    const callA = await activeCall();
    const callB = await activeCall();

    await expectProblem(
      await postEvents(
        agentRequest(callA.callId, 'events', `garbage-${randomUUID()}`, 'POST', {
          events: [],
        }),
        routeContext(callA.callId),
      ),
      401,
      'invalid_agent_token',
    );
    await expectProblem(
      await postEvents(
        agentRequest(callB.callId, 'events', callA.agentToken, 'POST', { events: [] }),
        routeContext(callB.callId),
      ),
      404,
      'call_not_found',
    );
    expect(
      (
        await postEvents(
          agentRequest(callA.callId, 'events', callA.agentToken, 'POST', { events: [] }),
          routeContext(callA.callId),
        )
      ).status,
    ).toBe(200);
  });

  it('expires failed-call credentials on every endpoint but keeps incomplete correctable', async () => {
    const failed = await activeCall();
    await withTestPool(async (pool) => {
      await pool.query(
        `UPDATE calls SET state = 'failed', ended_reason = 'upstream_unavailable'
         WHERE id = $1`,
        [failed.callId],
      );
    });

    const failedResponses = [
      await fetchConfig(
        agentRequest(failed.callId, 'config', failed.agentToken, 'GET'),
        routeContext(failed.callId),
      ),
      await postEvents(
        agentRequest(failed.callId, 'events', failed.agentToken, 'POST', {
          events: [],
        }),
        routeContext(failed.callId),
      ),
      await postComplete(
        agentRequest(failed.callId, 'complete', failed.agentToken, 'POST', {
          endedReason: 'pipeline_error',
          durationSecs: 1,
        }),
        routeContext(failed.callId),
      ),
    ];
    for (const response of failedResponses) {
      await expectProblem(response, 401, 'agent_token_expired');
    }

    const incomplete = await activeCall();
    await withTestPool(async (pool) => {
      await pool.query(
        `UPDATE calls SET state = 'incomplete', ended_reason = 'agent_lost'
         WHERE id = $1`,
        [incomplete.callId],
      );
    });
    await expectProblem(
      await fetchConfig(
        agentRequest(incomplete.callId, 'config', incomplete.agentToken, 'GET'),
        routeContext(incomplete.callId),
      ),
      409,
      'invalid_request',
    );
    expect(
      (
        await postEvents(
          agentRequest(incomplete.callId, 'events', incomplete.agentToken, 'POST', {
            events: [],
          }),
          routeContext(incomplete.callId),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await postComplete(
          agentRequest(incomplete.callId, 'complete', incomplete.agentToken, 'POST', {
            endedReason: 'idle_timeout',
            durationSecs: 12.345,
          }),
          routeContext(incomplete.callId),
        )
      ).status,
    ).toBe(200);
  });
});

describeDatabase('agent event route validation and idempotency', () => {
  it('keeps duration unknown when a production-shaped active call is swept', async () => {
    const call = await activeCall();
    const eventResponse = await postEvents(
      agentRequest(call.callId, 'events', call.agentToken, 'POST', {
        events: [
          {
            seq: 1,
            at: '2026-09-20T10:00:00.123456+00:00',
            type: 'interruption',
            payload: { observed: true },
          },
        ],
      }),
      routeContext(call.callId),
    );
    expect(eventResponse.status).toBe(200);

    const sweepAt = new Date();
    const staleAt = new Date(sweepAt.getTime() - ACTIVE_STALE_AFTER_MS - 1_000);
    await withTestPool(async (pool) => {
      const before = await pool.query<{
        state: string;
        duration_secs: string | null;
        event_count: string;
      }>(
        `SELECT c.state,
                c.duration_secs::text,
                count(e.seq)::text AS event_count
         FROM calls c
         LEFT JOIN call_events e ON e.call_id = c.id
         WHERE c.id = $1
         GROUP BY c.id`,
        [call.callId],
      );
      expect(before.rows[0]).toMatchObject({
        state: 'active',
        duration_secs: null,
        event_count: '1',
      });
      await pool.query(
        `UPDATE calls
         SET started_at = $2, last_heartbeat_at = $2
         WHERE id = $1`,
        [call.callId, staleAt],
      );
    });

    await sweepStaleCalls(sweepAt);

    await withTestPool(async (pool) => {
      const after = await pool.query<{
        state: string;
        ended_reason: string | null;
        duration_secs: string | null;
        event_count: string;
      }>(
        `SELECT c.state,
                c.ended_reason,
                c.duration_secs::text,
                count(e.seq)::text AS event_count
         FROM calls c
         LEFT JOIN call_events e ON e.call_id = c.id
         WHERE c.id = $1
         GROUP BY c.id`,
        [call.callId],
      );
      expect(after.rows[0]).toMatchObject({
        state: 'incomplete',
        ended_reason: 'agent_lost',
        duration_secs: null,
        event_count: '2',
      });
    });
  });

  it('accepts an empty heartbeat with exact 200 and rejects malformed emptiness unchanged', async () => {
    const call = await activeCall();
    await withTestPool(async (pool) => {
      await pool.query(
        `UPDATE calls SET last_heartbeat_at = '2020-01-01T00:00:00Z'
         WHERE id = $1`,
        [call.callId],
      );
    });
    const before = await heartbeat(call.callId);

    const accepted = await postEvents(
      agentRequest(call.callId, 'events', call.agentToken, 'POST', { events: [] }),
      routeContext(call.callId),
    );
    expect(accepted.status).toBe(200);
    const afterAccepted = await heartbeat(call.callId);
    expect(afterAccepted).not.toBe(before);

    const rejected = await postEvents(
      agentRequest(call.callId, 'events', call.agentToken, 'POST', {}),
      routeContext(call.callId),
    );
    await expectProblem(rejected, 400, 'invalid_request');
    expect(await heartbeat(call.callId)).toBe(afterAccepted);
  });

  it('accepts all eight source-defined event types and preserves microseconds', async () => {
    const call = await activeCall();
    const events = AGENT_EVENT_TYPES.map((type, index) => ({
      seq: index + 1,
      at: `2026-09-20T10:00:0${index}.123456+00:00`,
      type,
      payload: { type, exact: index },
    }));

    const response = await postEvents(
      agentRequest(call.callId, 'events', call.agentToken, 'POST', { events }),
      routeContext(call.callId),
    );
    expect(response.status).toBe(200);

    const stored = await withTestPool(async (pool) => {
      const { rows } = await pool.query<{
        seq: number;
        at: string;
        type: string;
        payload: unknown;
      }>(
        `SELECT seq,
                to_char(
                  at AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
                ) AS at,
                type,
                payload
         FROM call_events
         WHERE call_id = $1 ORDER BY seq`,
        [call.callId],
      );
      return rows;
    });
    expect(stored).toHaveLength(AGENT_EVENT_TYPES.length);
    expect(stored.map((row) => row.type)).toStrictEqual([...AGENT_EVENT_TYPES]);
    expect(stored.map((row) => row.payload)).toStrictEqual(
      events.map((event) => event.payload),
    );
    expect(stored.map((row) => row.at)).toStrictEqual(
      events.map((event) => event.at.replace('+00:00', 'Z')),
    );
  });

  it('rejects duplicate sequences atomically and accepts a clean control batch', async () => {
    const call = await activeCall();
    const duplicate = [
      { seq: 1, at: '2026-09-20T10:00:00.123456+00:00', type: 'interruption', payload: {} },
      { seq: 1, at: '2026-09-20T10:00:01.123456+00:00', type: 'transcript_user', payload: { text: 'duplicate' } },
    ];

    await expectProblem(
      await postEvents(
        agentRequest(call.callId, 'events', call.agentToken, 'POST', { events: duplicate }),
        routeContext(call.callId),
      ),
      400,
      'invalid_request',
    );
    expect(await eventCount(call.callId)).toBe(0);

    expect(
      (
        await postEvents(
          agentRequest(call.callId, 'events', call.agentToken, 'POST', {
            events: [duplicate[0]],
          }),
          routeContext(call.callId),
        )
      ).status,
    ).toBe(200);
    expect(await eventCount(call.callId)).toBe(1);
  });

  it('rejects an unknown event type atomically while every real type has a control', async () => {
    const call = await activeCall();
    const valid = {
      seq: 1,
      at: '2026-09-20T10:00:00.123456+00:00',
      type: AGENT_EVENT_TYPES[0],
      payload: {},
    };

    await expectProblem(
      await postEvents(
        agentRequest(call.callId, 'events', call.agentToken, 'POST', {
          events: [
            valid,
            {
              ...valid,
              seq: 2,
              type: 'invented_event_type',
            },
          ],
        }),
        routeContext(call.callId),
      ),
      400,
      'invalid_request',
    );
    expect(await eventCount(call.callId)).toBe(0);

    const controls = AGENT_EVENT_TYPES.map((type, index) => ({
      ...valid,
      seq: index + 1,
      type,
    }));
    expect(
      (
        await postEvents(
          agentRequest(call.callId, 'events', call.agentToken, 'POST', {
            events: controls,
          }),
          routeContext(call.callId),
        )
      ).status,
    ).toBe(200);
    expect(await eventCount(call.callId)).toBe(AGENT_EVENT_TYPES.length);
  });

  it('brackets the reserved sequence boundary with rule-specific details', async () => {
    const call = await activeCall();
    const make = (seq: number) => ({
      seq,
      at: '2026-09-20T10:00:00.123456+00:00',
      type: 'interruption',
      payload: {},
    });

    const low = await postEvents(
      agentRequest(call.callId, 'events', call.agentToken, 'POST', { events: [make(1)] }),
      routeContext(call.callId),
    );
    expect(low.status).toBe(200);
    const high = await postEvents(
      agentRequest(call.callId, 'events', call.agentToken, 'POST', {
        events: [make(999_999_999)],
      }),
      routeContext(call.callId),
    );
    expect(high.status).toBe(200);

    const reserved = await expectProblem(
      await postEvents(
        agentRequest(call.callId, 'events', call.agentToken, 'POST', {
          events: [make(1_000_000_000)],
        }),
        routeContext(call.callId),
      ),
      400,
      'invalid_request',
    );
    const nonInteger = await expectProblem(
      await postEvents(
        agentRequest(call.callId, 'events', call.agentToken, 'POST', {
          events: [make(1.5)],
        }),
        routeContext(call.callId),
      ),
      400,
      'invalid_request',
    );
    expect(reserved.detail).toContain('reserved');
    expect(nonInteger.detail).toContain('positive integer');
    expect(reserved.detail).not.toBe(nonInteger.detail);
    expect(await eventCount(call.callId)).toBe(2);
  });
});

describeDatabase('agent completion route', () => {
  it('returns exact 200 once, then expires the token without rewriting completion', async () => {
    const call = await activeCall();
    const first = await postComplete(
      agentRequest(call.callId, 'complete', call.agentToken, 'POST', {
        endedReason: 'client_disconnected',
        durationSecs: 12.345,
      }),
      routeContext(call.callId),
    );
    expect(first.status).toBe(200);
    const firstRow = await completionRow(call.callId);

    await expectProblem(
      await postComplete(
        agentRequest(call.callId, 'complete', call.agentToken, 'POST', {
          endedReason: 'pipeline_error',
          durationSecs: 99.999,
        }),
        routeContext(call.callId),
      ),
      401,
      'agent_token_expired',
    );
    expect(await completionRow(call.callId)).toStrictEqual(firstRow);
    expect(await eventCount(call.callId)).toBe(0);
  });

  it.each([
    ['unknown reason', { endedReason: 'invented', durationSecs: 1 }],
    ['negative duration', { endedReason: 'pipeline_error', durationSecs: -1 }],
    ['non-finite duration', { endedReason: 'pipeline_error', durationSecs: Number.POSITIVE_INFINITY }],
    ['missing duration', { endedReason: 'pipeline_error' }],
  ])('rejects %s and preserves active state', async (_label, body) => {
    const call = await activeCall();

    await expectProblem(
      await postComplete(
        agentRequest(call.callId, 'complete', call.agentToken, 'POST', body),
        routeContext(call.callId),
      ),
      400,
      'invalid_request',
    );
    expect(await completionRow(call.callId)).toMatchObject({
      state: 'active',
      ended_reason: null,
      duration_secs: null,
      ended_at: null,
    });

    expect(
      (
        await postComplete(
          agentRequest(call.callId, 'complete', call.agentToken, 'POST', {
            endedReason: 'pipeline_error',
            durationSecs: 1.25,
          }),
          routeContext(call.callId),
        )
      ).status,
    ).toBe(200);
  });
});

async function eventCount(callId: string): Promise<number> {
  return withTestPool(async (pool) => {
    const { rows } = await pool.query<{ hits: string }>(
      'SELECT count(*)::text AS hits FROM call_events WHERE call_id = $1',
      [callId],
    );
    return Number(rows[0]?.hits ?? 0);
  });
}

async function completionRow(callId: string): Promise<{
  state: string;
  ended_reason: string | null;
  duration_secs: string | null;
  ended_at: string | null;
}> {
  return withTestPool(async (pool) => {
    const { rows } = await pool.query<{
      state: string;
      ended_reason: string | null;
      duration_secs: string | null;
      ended_at: string | null;
    }>(
      `SELECT state, ended_reason, duration_secs::text, ended_at::text
       FROM calls WHERE id = $1`,
      [callId],
    );
    return rows[0]!;
  });
}
