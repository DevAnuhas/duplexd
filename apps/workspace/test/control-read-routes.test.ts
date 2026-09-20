import { randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';

import { GET as listCalls } from '@/app/v1/calls/route';
import { GET as getCall } from '@/app/v1/calls/[id]/route';
import { mintApiKey } from '@/data/api-keys';
import { closeDb, getDb } from '@/db/client';
import { callEvents, callRateLimits, calls } from '@/db/schema';

import { signUpNewAccount } from './helpers/auth.ts';
import { bearer, expectProblem } from './helpers/control.ts';
import { withTestPool } from './helpers/database.ts';
import { isDatabaseConfigured } from './helpers/environment.ts';

const describeDatabase = describe.skipIf(!isDatabaseConfigured());
const detailContext = (id: string) => ({ params: Promise.resolve({ id }) });

afterAll(async () => {
  await closeDb();
});

async function seedCall(input: {
  accountId: string;
  apiKeyId: string;
  createdAt: Date;
  durationSecs?: number;
  state?: string;
  secretCanary?: string;
}): Promise<string> {
  const id = randomUUID();
  await getDb().insert(calls).values({
    id,
    accountId: input.accountId,
    apiKeyId: input.apiKeyId,
    assistantSnapshot: {
      assistantId: `snapshot-${id}`,
      serverSecretCiphertext: input.secretCanary ?? `ciphertext-${id}`,
    },
    agentTokenHash: randomUUID().replaceAll('-', '').padEnd(64, '0'),
    state: input.state ?? 'ended',
    endedReason: 'client_disconnected',
    createdAt: input.createdAt,
    durationSecs: input.durationSecs ?? 12.345,
  });
  return id;
}

function customerRequest(rawKey: string, path: string): Request {
  return new Request(`http://localhost:3000${path}`, { headers: bearer(rawKey) });
}

describeDatabase('customer call detail and account scoping', () => {
  it('makes another account’s call indistinguishable from an absent id', async () => {
    const [accountA, accountB] = await Promise.all([
      signUpNewAccount(),
      signUpNewAccount(),
    ]);
    const [keyA, keyB] = await Promise.all([
      mintApiKey(accountA.accountId, 'read key A', accountA.userId),
      mintApiKey(accountB.accountId, 'read key B', accountB.userId),
    ]);
    const callB = await seedCall({
      accountId: accountB.accountId,
      apiKeyId: keyB.id,
      createdAt: new Date(),
    });

    const other = await getCall(
      customerRequest(keyA.raw, `/v1/calls/${callB}`),
      detailContext(callB),
    );
    const missingId = randomUUID();
    const missing = await getCall(
      customerRequest(keyA.raw, `/v1/calls/${missingId}`),
      detailContext(missingId),
    );

    expect(other.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await other.text()).toBe(await missing.text());

    const own = await getCall(
      customerRequest(keyB.raw, `/v1/calls/${callB}`),
      detailContext(callB),
    );
    expect(own.status).toBe(200);
  });

  it('returns numeric duration and ordered events while omitting every private field', async () => {
    const account = await signUpNewAccount();
    const key = await mintApiKey(account.accountId, 'detail key', account.userId);
    const secretCiphertextCanary = `ciphertext-canary-${randomUUID()}`;
    const transcriptCanary = `transcript-canary-${randomUUID()}`;
    const callId = await seedCall({
      accountId: account.accountId,
      apiKeyId: key.id,
      createdAt: new Date(),
      durationSecs: 12.345,
      secretCanary: secretCiphertextCanary,
    });
    await getDb().insert(callEvents).values([
      {
        callId,
        seq: 2,
        at: new Date('2026-09-20T10:00:02Z'),
        type: 'transcript_assistant',
        payload: { text: transcriptCanary },
      },
      {
        callId,
        seq: 1,
        at: new Date('2026-09-20T10:00:01Z'),
        type: 'bot_speech_started',
        payload: {},
      },
    ]);

    const response = await getCall(
      customerRequest(key.raw, `/v1/calls/${callId}`),
      detailContext(callId),
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    const body = JSON.parse(text) as {
      call: { durationSecs: unknown };
      events: Array<{ seq: number }>;
    };

    expect(typeof body.call.durationSecs).toBe('number');
    expect(body.call.durationSecs).toBe(12.345);
    expect(body.events.map((event) => event.seq)).toStrictEqual([1, 2]);
    expect(text).not.toContain(secretCiphertextCanary);
    expect(text).not.toContain(transcriptCanary);
    expect(text).not.toContain(key.raw);

    const storedHash = await withTestPool(async (pool) => {
      const { rows } = await pool.query<{ agent_token_hash: string }>(
        'SELECT agent_token_hash FROM calls WHERE id = $1',
        [callId],
      );
      return rows[0]!.agent_token_hash;
    });
    expect(text).not.toContain(storedHash);
  });
});

describeDatabase('stable cursor pagination', () => {
  it('pages tied timestamps exactly once, stays scoped, and ignores create-rate limits', async () => {
    const [accountA, accountB] = await Promise.all([
      signUpNewAccount(),
      signUpNewAccount(),
    ]);
    const [keyA, keyB] = await Promise.all([
      mintApiKey(accountA.accountId, 'pagination key A', accountA.userId),
      mintApiKey(accountB.accountId, 'pagination key B', accountB.userId),
    ]);
    const tied = new Date('2026-09-20T10:00:00.000Z');
    const ownIds = await Promise.all(
      Array.from({ length: 5 }, () =>
        seedCall({ accountId: accountA.accountId, apiKeyId: keyA.id, createdAt: tied }),
      ),
    );
    const otherId = await seedCall({
      accountId: accountB.accountId,
      apiKeyId: keyB.id,
      createdAt: tied,
    });
    await getDb().insert(callRateLimits).values({
      apiKeyId: keyA.id,
      windowStartedAt: new Date(
        Math.floor(Date.now() / 60_000) * 60_000,
      ),
      count: 999,
    });

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const url = new URL('http://localhost:3000/v1/calls');
      url.searchParams.set('limit', '2');
      if (cursor !== null) {
        url.searchParams.set('cursor', cursor);
      }
      const response = await listCalls(
        new Request(url, { headers: bearer(keyA.raw) }),
      );
      expect(response.status).toBe(200);
      const page = (await response.json()) as {
        calls: Array<{ id: string; durationSecs: unknown }>;
        nextCursor: string | null;
      };
      expect(page.calls.length).toBeGreaterThan(0);
      expect(page.calls.every((call) => typeof call.durationSecs === 'number')).toBe(true);
      seen.push(...page.calls.map((call) => call.id));
      cursor = page.nextCursor;
    } while (cursor !== null);

    expect(seen.sort()).toStrictEqual(ownIds.sort());
    expect(new Set(seen).size).toBe(ownIds.length);
    expect(seen).not.toContain(otherId);

    const malformed = await listCalls(
      customerRequest(keyA.raw, '/v1/calls?limit=2&cursor=not-a-cursor'),
    );
    await expectProblem(malformed, 400, 'invalid_request');
    expect(
      (
        await listCalls(customerRequest(keyA.raw, '/v1/calls?limit=2'))
      ).status,
    ).toBe(200);
  });
});
