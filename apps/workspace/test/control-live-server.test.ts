import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ACTIVE_STALE_AFTER_MS, AGENT_EVENT_TYPES } from '@/control/constants';
import { mintApiKey } from '@/data/api-keys';
import { closeDb, getDb } from '@/db/client';
import { callEvents, calls } from '@/db/schema';
import { hashCredential } from '@/lib/credentials';
import { encryptSecret } from '@/lib/crypto';

import { signUpNewAccount } from './helpers/auth.ts';
import { withTestPool } from './helpers/database.ts';
import { isDatabaseConfigured } from './helpers/environment.ts';

const describeDatabase = describe.skipIf(!isDatabaseConfigured());
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const standaloneServer = `${repositoryRoot}apps/workspace/.next/standalone/apps/workspace/server.js`;
const SWEEP_TOKEN = 'standalone-synthetic-sweep-token';

let server: ChildProcessWithoutNullStreams | undefined;
let serverOutput = '';

beforeAll(() => {
  const buildEnvironment = { ...process.env };
  for (const name of [
    'DATABASE_URL',
    'BETTER_AUTH_SECRET',
    'BETTER_AUTH_URL',
    'ASSISTANT_SECRET_KEY',
    'PIPECAT_API_KEY',
    'CALL_SWEEP_TOKEN',
    'DATABASE_URL_UNPOOLED',
    'NEON_PRODUCTION_BRANCH_ID',
    'TEST',
    'VITEST',
    'VITEST_WORKER_ID',
  ]) {
    delete buildEnvironment[name];
  }

  const built = spawnSync('pnpm', ['--filter', 'workspace', 'build'], {
    cwd: repositoryRoot,
    env: buildEnvironment,
    encoding: 'utf8',
  });
  expect(
    built.status,
    `production build failed before the process tests:\n${built.stdout}\n${built.stderr}`,
  ).toBe(0);
}, 120_000);

afterAll(async () => {
  if (server !== undefined && server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([
      new Promise<void>((resolve) => server?.once('exit', () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]);
    if (server.exitCode === null) {
      server.kill('SIGKILL');
      await new Promise<void>((resolve) =>
        server?.once('exit', () => resolve()),
      );
    }
  }
  await closeDb();
});

function productionEnvironment(port: number): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    PORT: String(port),
    HOSTNAME: '127.0.0.1',
    PATH: process.env.PATH,
    DATABASE_URL: process.env.DATABASE_URL,
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: `http://127.0.0.1:${port}`,
    ASSISTANT_SECRET_KEY: process.env.ASSISTANT_SECRET_KEY,
    PIPECAT_API_KEY: process.env.PIPECAT_API_KEY,
    CALL_SWEEP_TOKEN: SWEEP_TOKEN,
  };
}

async function unusedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const listener = createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address();
      if (address === null || typeof address === 'string') {
        listener.close();
        reject(new Error('Node did not allocate a TCP port.'));
        return;
      }
      listener.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

function launch(
  port: number,
  env = productionEnvironment(port),
): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [standaloneServer], {
    cwd: repositoryRoot,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  }
}

async function waitForHttp(port: number): Promise<void> {
  await waitFor(
    `server on port ${port}`,
    async () => {
      try {
        await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual' });
        return true;
      } catch {
        return false;
      }
    },
    20_000,
  );
}

async function routeClassStatuses(port: number): Promise<number[]> {
  const origin = `http://127.0.0.1:${port}`;
  const responses = await Promise.all([
    fetch(`${origin}/`, { redirect: 'manual' }),
    fetch(`${origin}/v1/calls`, { redirect: 'manual' }),
    fetch(`${origin}/v1/agent/calls/missing/config`, { redirect: 'manual' }),
    fetch(`${origin}/v1/internal/sweep`, {
      method: 'POST',
      headers: { authorization: `Bearer ${SWEEP_TOKEN}` },
      redirect: 'manual',
    }),
  ]);
  return responses.map((response) => response.status);
}

async function waitFor(
  description: string,
  predicate: () => boolean | Promise<boolean>,
  waitMs: number,
): Promise<void> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function seedStandaloneCall(input: {
  accountId: string;
  state: 'starting' | 'active' | 'ended';
  createdAt: Date;
  startedAt?: Date | null;
  heartbeat?: Date | null;
  durationSecs?: number | null;
  rawToken?: string;
  webhookPlaintext?: string;
}): Promise<{ callId: string; rawToken: string; ciphertext: string }> {
  const callId = randomUUID();
  const rawToken = input.rawToken ?? `standalone-agent-${randomUUID()}`;
  const webhookPlaintext =
    input.webhookPlaintext ?? `standalone-webhook-${randomUUID()}`;
  const ciphertext = encryptSecret(webhookPlaintext);

  await getDb()
    .insert(calls)
    .values({
      id: callId,
      accountId: input.accountId,
      assistantSnapshot: {
        assistantId: `assistant-${callId}`,
        voice: 'marin',
        instructions: 'Standalone synthetic instructions.',
        accentStyle: '',
        waitingBehavior: '',
        backendModel: 'gpt-test-responses',
        backendInstructions: 'Use only synthetic inputs.',
        serverUrl: 'https://customer.example.invalid/tools',
        serverSecretCiphertext: ciphertext,
        tools: [],
      },
      agentTokenHash: hashCredential(rawToken),
      state: input.state,
      createdAt: input.createdAt,
      startedAt: input.startedAt ?? null,
      lastHeartbeatAt: input.heartbeat ?? null,
      durationSecs: input.durationSecs ?? null,
    });

  return { callId, rawToken, ciphertext };
}

async function callRecord(callId: string): Promise<Record<string, unknown>> {
  return withTestPool(async (pool) => {
    const { rows } = await pool.query<{ row: Record<string, unknown> }>(
      `SELECT to_jsonb(c) - 'assistant_snapshot' - 'agent_token_hash' AS row
       FROM calls c WHERE id = $1`,
      [callId],
    );
    return rows[0]!.row;
  });
}

describeDatabase('standalone startup validation', () => {
  it('serves all route classes when configured and is genuinely outside Better Auth test mode', async () => {
    const port = await unusedPort();
    const child = launch(port);
    let output = '';
    child.stdout.on('data', (chunk) => (output += String(chunk)));
    child.stderr.on('data', (chunk) => (output += String(chunk)));
    await waitForHttp(port);

    expect(await routeClassStatuses(port)).toStrictEqual([307, 401, 401, 200]);
    expect(output).toContain(
      'Better Auth production mode verified (isTest=false)',
    );
    await stop(child);
  });

  it('keeps customer routes serving when only the sweep token is absent', async () => {
    const port = await unusedPort();
    const env = productionEnvironment(port);
    delete env.CALL_SWEEP_TOKEN;
    const child = launch(port, env);
    let output = '';
    child.stdout.on('data', (chunk) => (output += String(chunk)));
    child.stderr.on('data', (chunk) => (output += String(chunk)));
    await waitForHttp(port);

    expect(await routeClassStatuses(port)).toStrictEqual([307, 401, 401, 401]);
    expect(output).toContain('CALL_SWEEP_TOKEN');
    await stop(child);
  });

  it('returns 500 on every route class for an invalid encryption key without logging its value', async () => {
    const port = await unusedPort();
    const env = productionEnvironment(port);
    const canary = 'startup-canary-not-hex';
    env.ASSISTANT_SECRET_KEY = canary;
    const child = launch(port, env);
    let output = '';
    child.stdout.on('data', (chunk) => (output += String(chunk)));
    child.stderr.on('data', (chunk) => (output += String(chunk)));
    await waitForHttp(port);

    expect(await routeClassStatuses(port)).toStrictEqual([500, 500, 500, 500]);
    expect(output).toContain('ASSISTANT_SECRET_KEY');
    expect(output).not.toContain(canary);
    await stop(child);
  });

  it('returns 500 when the P05 provider key is missing', async () => {
    const port = await unusedPort();
    const env = productionEnvironment(port);
    env.PIPECAT_API_KEY = '';
    const child = launch(port, env);
    let output = '';
    child.stdout.on('data', (chunk) => (output += String(chunk)));
    child.stderr.on('data', (chunk) => (output += String(chunk)));
    await waitForHttp(port);

    expect(
      (await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual' })).status,
    ).toBe(500);
    expect(output).toContain('PIPECAT_API_KEY');
    await stop(child);
  });
});

describeDatabase('real standalone server behavior', () => {
  let port = 0;
  let freshCallId = '';
  let staleCallId = '';
  let bootSnapshot: Record<string, unknown> = {};
  let pageAccount: Awaited<ReturnType<typeof signUpNewAccount>>;
  let otherAccount: Awaited<ReturnType<typeof signUpNewAccount>>;
  let liveCallId = '';
  let liveCanaries: string[] = [];

  beforeAll(async () => {
    port = await unusedPort();
    [pageAccount, otherAccount] = await Promise.all([
      signUpNewAccount(),
      signUpNewAccount(),
    ]);
    const now = Date.now();
    const fresh = await seedStandaloneCall({
      accountId: pageAccount.accountId,
      state: 'active',
      createdAt: new Date(now - 60_000),
      startedAt: new Date(now - 60_000),
      heartbeat: new Date(now),
    });
    const stale = await seedStandaloneCall({
      accountId: pageAccount.accountId,
      state: 'active',
      createdAt: new Date(now - ACTIVE_STALE_AFTER_MS - 60_000),
      startedAt: new Date(now - ACTIVE_STALE_AFTER_MS - 60_000),
      heartbeat: new Date(now - ACTIVE_STALE_AFTER_MS - 1_000),
    });
    freshCallId = fresh.callId;
    staleCallId = stale.callId;
    await getDb()
      .insert(callEvents)
      .values({
        callId: staleCallId,
        seq: 1,
        at: new Date(now - 180_000),
        type: 'interruption',
        payload: { beforeBoot: true },
      });
    bootSnapshot = await callRecord(staleCallId);

    server = launch(port);
    server.stdout.on('data', (chunk) => (serverOutput += String(chunk)));
    server.stderr.on('data', (chunk) => (serverOutput += String(chunk)));
    await waitFor(
      'the standalone server to report ready',
      () => /Ready/i.test(serverOutput),
      20_000,
    );
  }, 45_000);

  it('changes nothing at boot and sweeps only through the authenticated external endpoint', async () => {
    expect(await callRecord(staleCallId)).toStrictEqual(bootSnapshot);
    expect((await callRecord(freshCallId)).state).toBe('active');
    expect(await eventCount(staleCallId)).toBe(1);

    const stalePage = await fetch(
      `http://127.0.0.1:${port}/calls/${staleCallId}`,
      { headers: { cookie: pageAccount.cookie }, redirect: 'manual' },
    );
    const staleHtml = await stalePage.text();
    expect(stalePage.status).toBe(200);
    expect(staleHtml).toContain('incomplete');
    expect(staleHtml).toContain('agent_lost');
    expect(staleHtml).toContain('not recorded');
    expect(await callRecord(staleCallId)).toStrictEqual(bootSnapshot);
    expect(await eventCount(staleCallId)).toBe(1);

    const first = await fetch(`http://127.0.0.1:${port}/v1/internal/sweep`, {
      method: 'POST',
      headers: { authorization: `Bearer ${SWEEP_TOKEN}` },
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      incomplete: expect.any(Number),
      failed: expect.any(Number),
    });

    expect(await callRecord(staleCallId)).toMatchObject({
      state: 'incomplete',
      ended_reason: 'agent_lost',
      duration_secs: null,
    });
    expect((await callRecord(freshCallId)).state).toBe('active');
    expect(await eventCount(staleCallId)).toBe(2);

    const second = await fetch(`http://127.0.0.1:${port}/v1/internal/sweep`, {
      method: 'POST',
      headers: { authorization: `Bearer ${SWEEP_TOKEN}` },
    });
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      incomplete: expect.any(Number),
      failed: expect.any(Number),
    });
    expect(await callRecord(staleCallId)).toMatchObject({
      state: 'incomplete',
      ended_reason: 'agent_lost',
    });
    expect(await eventCount(staleCallId)).toBe(2);

    const get = await fetch(`http://127.0.0.1:${port}/v1/internal/sweep`);
    expect(get.status).toBe(405);
  });

  it('uses x-real-ip buckets and ignores every forgeable fallback header', async () => {
    const origin = `http://127.0.0.1:${port}`;
    const ipA = '203.0.113.10';
    const ipB = '203.0.113.11';

    async function signup(
      ip: string,
      forged: Record<string, string> = {},
    ): Promise<Response> {
      const email = `rate-${randomUUID()}@example.invalid`;
      return fetch(`${origin}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin,
          'x-real-ip': ip,
          ...forged,
        },
        body: JSON.stringify({
          email,
          name: email,
          password: `Rate-limit-${randomUUID()}!`,
        }),
      });
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await signup(ipA)).status).toBe(200);
    }
    expect((await signup(ipA)).status).toBe(429);

    expect((await signup(ipB)).status).toBe(200);

    for (const header of [
      'x-forwarded-for',
      'x-vercel-forwarded-for',
      'fly-client-ip',
    ]) {
      expect((await signup(ipB, { [header]: ipA })).status).toBe(200);
      expect((await signup(ipA, { [header]: ipB })).status).toBe(429);
    }
  }, 60_000);

  it('runs the real Python PlatformClient through config, all events, and completion', async () => {
    const transcriptCanary = `transcript-canary-${randomUUID()}`;
    const webhookPlaintext = `webhook-canary-${randomUUID()}`;
    const started = await seedStandaloneCall({
      accountId: pageAccount.accountId,
      state: 'starting',
      createdAt: new Date(),
      rawToken: `agent-token-canary-${randomUUID()}`,
      webhookPlaintext,
    });
    liveCallId = started.callId;
    liveCanaries = [
      started.rawToken,
      webhookPlaintext,
      started.ciphertext,
      transcriptCanary,
    ];
    const runner = {
      callId: started.callId,
      apiBase: `http://127.0.0.1:${port}`,
      agentToken: started.rawToken,
      transcriptCanary,
    };
    const python = spawnSync(
      'uv',
      [
        'run',
        '--directory',
        'agent',
        'python',
        '-c',
        [
          'import asyncio,json,sys',
          'from datetime import UTC,datetime',
          'from duplexd_agent.config import RunnerInput',
          'from duplexd_agent.platform import PlatformClient,encode_json',
          'from duplexd_agent.reporting import EVENT_TYPES',
          'body=json.load(sys.stdin)',
          'transcript=body.pop("transcriptCanary")',
          'runner=RunnerInput.from_body(body)',
          'async def main():',
          '  async with PlatformClient(runner) as client:',
          '    await client.fetch_config()',
          '    events=[]',
          '    for seq,event_type in enumerate(sorted(EVENT_TYPES),1):',
          '      payload={"text":transcript} if event_type=="transcript_user" else {}',
          '      events.append({"seq":seq,"at":datetime.now(UTC).isoformat(),"type":event_type,"payload":payload})',
          '    assert await client.post_events(encode_json({"events":events}))',
          '    assert await client.post_complete(encode_json({"endedReason":"client_disconnected","durationSecs":12.345}))',
          'asyncio.run(main())',
        ].join('\n'),
      ],
      {
        cwd: repositoryRoot,
        input: JSON.stringify(runner),
        encoding: 'utf8',
      },
    );
    expect(python.status, `real Python client failed: ${python.stderr}`).toBe(
      0,
    );

    expect(await callRecord(started.callId)).toMatchObject({
      state: 'ended',
      ended_reason: 'client_disconnected',
      duration_secs: 12.345,
    });
    expect(await eventCount(started.callId)).toBe(AGENT_EVENT_TYPES.length);
    await waitFor(
      'the safe event log control',
      () => serverOutput.includes(`call=${started.callId}`),
      5_000,
    );
    expect(serverOutput).toContain(`count=${AGENT_EVENT_TYPES.length}`);
    expect(serverOutput).not.toContain(started.rawToken);
    expect(serverOutput).not.toContain(webhookPlaintext);
    expect(serverOutput).not.toContain(started.ciphertext);
    expect(serverOutput).not.toContain(transcriptCanary);
  }, 60_000);

  it('scopes real-session pages, redirects unauthenticated requests, and renders durations', async () => {
    const ownKey = await mintApiKey(
      pageAccount.accountId,
      'page canary key',
      pageAccount.userId,
    );
    const own = await seedStandaloneCall({
      accountId: pageAccount.accountId,
      state: 'ended',
      createdAt: new Date(),
      durationSecs: 12.345,
    });
    const other = await seedStandaloneCall({
      accountId: otherAccount.accountId,
      state: 'ended',
      createdAt: new Date(),
      durationSecs: 99.999,
    });
    const listResponse = await fetch(`http://127.0.0.1:${port}/calls`, {
      headers: { cookie: pageAccount.cookie },
      redirect: 'manual',
    });
    const listHtml = await listResponse.text();
    expect(listResponse.status).toBe(200);
    expect(listHtml).toContain(own.callId);
    expect(listHtml).toContain('12.345 seconds');
    expect(listHtml).not.toContain(other.callId);
    expect(listHtml).not.toContain(ownKey.raw);

    const ownDetail = await fetch(
      `http://127.0.0.1:${port}/calls/${own.callId}`,
      { headers: { cookie: pageAccount.cookie }, redirect: 'manual' },
    );
    expect(ownDetail.status).toBe(200);
    expect(await ownDetail.text()).toContain('12.345 seconds');

    const liveDetail = await fetch(
      `http://127.0.0.1:${port}/calls/${liveCallId}`,
      { headers: { cookie: pageAccount.cookie }, redirect: 'manual' },
    );
    const liveHtml = await liveDetail.text();
    expect(liveDetail.status).toBe(200);
    for (const canary of [...liveCanaries, ownKey.raw]) {
      expect(`${listHtml}\n${liveHtml}`).not.toContain(canary);
    }

    const otherDetail = await fetch(
      `http://127.0.0.1:${port}/calls/${other.callId}`,
      { headers: { cookie: pageAccount.cookie }, redirect: 'manual' },
    );
    expect(otherDetail.status).toBe(404);

    const unauthenticated = await fetch(`http://127.0.0.1:${port}/calls`, {
      redirect: 'manual',
    });
    expect([303, 307, 308]).toContain(unauthenticated.status);
    expect(unauthenticated.headers.get('location')).toContain('/sign-in');
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
