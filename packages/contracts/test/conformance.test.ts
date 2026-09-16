import { createServer } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { signHandlerRequest } from '@duplexd/contracts';
import {
  CONFORMANCE_SCENARIOS,
  type ConformanceReport,
  type ConformanceScenarioName,
  loadScenario,
  type RunningHandler,
  runConformance,
  startBufferingHandler,
  startReferenceHandler,
} from '@duplexd/contracts/conformance';

import {
  listFixtures,
  readFixtureJson,
  SYNTHETIC_TEST_SECRET,
} from './support/fixtures.js';

const secret = SYNTHETIC_TEST_SECRET;

async function startProblemServer(chunks: string[]): Promise<RunningHandler> {
  const server = createServer((_request, response) => {
    response.writeHead(400, { 'content-type': 'application/problem+json' });
    for (const chunk of chunks) response.write(chunk);
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('test server did not bind');
  }
  return {
    url: `http://127.0.0.1:${address.port}/delegations`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        ),
      ),
  };
}

/** The fourteen scenarios the spec's table requires, by name. */
const REQUIRED_SCENARIOS: ConformanceScenarioName[] = [
  'booking-request',
  'order-status-request',
  'empty-transcript',
  'unknown-fields',
  'prior-delegations',
  'bad-signature',
  'stale-timestamp',
  'unsupported-version',
  'metadata-mismatch-session',
  'metadata-mismatch-version',
  'metadata-duplicate-header',
  'replayed-request',
  'concurrent-replay',
  'keepalive-under-delay',
];

/** The sole buffering oracle: the only scenario with a deliberate delay. */
const BUFFERING_ORACLE: ConformanceScenarioName = 'keepalive-under-delay';

let reference: RunningHandler;
let buffering: RunningHandler;
let referenceReport: ConformanceReport;
let bufferingReport: ConformanceReport;
let bufferingElapsedMs = 0;

beforeAll(async () => {
  reference = await startReferenceHandler(secret);
  buffering = await startBufferingHandler(secret);
  referenceReport = await runConformance({ url: reference.url, secret });

  const started = performance.now();
  bufferingReport = await runConformance({ url: buffering.url, secret });
  bufferingElapsedMs = performance.now() - started;
}, 60_000);

afterAll(async () => {
  await Promise.all([reference.close(), buffering.close()]);
});

const reasonsOf = (report: ConformanceReport) =>
  report.scenarios
    .filter((result) => !result.passed)
    .map((result) => `${result.name}: ${result.reason}`);

describe('the scenario inventory', () => {
  it('declares exactly the fourteen required scenarios', () => {
    expect([...CONFORMANCE_SCENARIOS].sort()).toEqual(
      [...REQUIRED_SCENARIOS].sort(),
    );
    expect(CONFORMANCE_SCENARIOS).toHaveLength(14);
  });

  it('has a fixture file per scenario and no orphans', () => {
    const files = listFixtures('conformance').map((file) =>
      file.replace(/\.json$/, ''),
    );
    expect(files.sort()).toEqual([...REQUIRED_SCENARIOS].sort());
  });

  it('gives every scenario a loadable fixture that names itself', async () => {
    for (const name of CONFORMANCE_SCENARIOS) {
      const fixture = await loadScenario(name);
      expect(fixture.name, `${name} fixture disagrees with its filename`).toBe(
        name,
      );
      expect(fixture.request, `${name} names no request fixture`).toBeTruthy();
      expect(
        ['valid_stream', 'problem', 'same_commentary', 'early_keepalive'],
        `${name} expectation`,
      ).toContain(fixture.expectation);
      if (fixture.expectation === 'problem') {
        expect(fixture.status, `${name} declares no status`).toBeTypeOf(
          'number',
        );
        expect(fixture.code, `${name} declares no code`).toBeTypeOf('string');
      }
    }
  });

  it('covers both metadata mismatches, the duplicate header and both replays', () => {
    for (const name of [
      'metadata-mismatch-session',
      'metadata-mismatch-version',
      'metadata-duplicate-header',
      'replayed-request',
      'concurrent-replay',
    ] as const) {
      expect(CONFORMANCE_SCENARIOS).toContain(name);
    }
  });
});

describe('runConformance against the reference handler', () => {
  it('passes every one of the fourteen scenarios', () => {
    expect(reasonsOf(referenceReport)).toEqual([]);
    expect(referenceReport.passed).toBe(true);
    expect(referenceReport.scenarios).toHaveLength(14);
  });

  it('reports one result per scenario, in the declared order', () => {
    expect(referenceReport.scenarios.map((result) => result.name)).toEqual([
      ...CONFORMANCE_SCENARIOS,
    ]);
  });

  it('leaves no reason on a passing scenario', () => {
    for (const result of referenceReport.scenarios) {
      expect(result.passed).toBe(true);
      expect(result.reason).toBeUndefined();
    }
  });
});

describe('scenario selection', () => {
  it('runs only the requested names', async () => {
    const report = await runConformance({
      url: reference.url,
      secret,
      scenarios: ['booking-request', 'bad-signature'],
    });
    expect(report.scenarios.map((result) => result.name)).toEqual([
      'booking-request',
      'bad-signature',
    ]);
    expect(report.passed).toBe(true);
  });

  it('rejects an unknown scenario name instead of silently skipping it', async () => {
    await expect(
      runConformance({
        url: reference.url,
        secret,
        scenarios: [
          'booking-request',
          'not-a-scenario' as ConformanceScenarioName,
        ],
      }),
    ).rejects.toThrow('Unknown conformance scenario');
  });

  it('runs a single scenario when asked for one', async () => {
    const report = await runConformance({
      url: reference.url,
      secret,
      scenarios: [BUFFERING_ORACLE],
    });
    expect(report.scenarios).toHaveLength(1);
    expect(report.passed).toBe(true);
  }, 30_000);
});

describe('runConformance against the deliberately buffering handler', () => {
  it('fails only the delayed keepalive scenario', () => {
    const failed = bufferingReport.scenarios
      .filter((result) => !result.passed)
      .map((result) => result.name);
    expect(failed).toEqual([BUFFERING_ORACLE]);
    expect(bufferingReport.passed).toBe(false);
  });

  it('still passes every scenario without a deliberate delay', () => {
    // A fast, fully correct but non-incremental response is not itself a
    // contract violation; only the delayed scenario can tell the two apart.
    for (const result of bufferingReport.scenarios) {
      if (result.name === BUFFERING_ORACLE) continue;
      expect(result.passed, `${result.name}: ${result.reason}`).toBe(true);
    }
    expect(bufferingReport.scenarios).toHaveLength(14);
  });

  it('fails within a bounded time rather than hanging on the delay', () => {
    // The whole fourteen-scenario run, including the aborted deadline, has to
    // finish well inside the handler's own 3000ms hold plus slack.
    expect(bufferingElapsedMs).toBeLessThan(30_000);
  });

  it('explains the failure in actionable, secret-free terms', () => {
    const failure = bufferingReport.scenarios.find(
      (result) => result.name === BUFFERING_ORACLE,
    );
    expect(failure?.reason).toBeTruthy();
    expect(failure?.reason).toMatch(/2000ms deadline/);
    for (const result of bufferingReport.scenarios) {
      expect(result.reason ?? '').not.toContain(secret);
    }
    expect(JSON.stringify(bufferingReport)).not.toContain(secret);
  });
});

describe('the keepalive deadline is measured over a real connection', () => {
  it('starts before dispatch, so connection and header wait both count', async () => {
    // Against the buffering handler nothing — not even the response headers —
    // arrives before the 3000ms hold elapses, so a deadline that only started
    // after the headers landed would never fire.
    const started = performance.now();
    const report = await runConformance({
      url: buffering.url,
      secret,
      scenarios: [BUFFERING_ORACLE],
    });
    const elapsed = performance.now() - started;

    expect(report.passed).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(1_900);
    // Bounded: it aborts at the deadline instead of waiting out the 3000ms.
    expect(elapsed).toBeLessThan(2_900);
  }, 30_000);

  it('passes against a handler that writes a keepalive before the delay', async () => {
    const started = performance.now();
    const report = await runConformance({
      url: reference.url,
      secret,
      scenarios: [BUFFERING_ORACLE],
    });
    const elapsed = performance.now() - started;

    expect(report.passed).toBe(true);
    // Bounded, but not fast: the runner cancels the body once it has seen the
    // keepalive, and cancelling waits for the handler's own 3000ms hold to
    // release the connection. The early-arrival claim is proved directly by
    // the time-to-first-byte test below, not by this total.
    expect(elapsed).toBeLessThan(15_000);
  }, 30_000);

  it('sees the reference keepalive within the deadline and the buffered one not at all', async () => {
    const fixture = readFixtureJson<{ request: Record<string, unknown> }>(
      'requests',
      'keepalive-delay.json',
    ).request;
    const raw = JSON.stringify(fixture);
    const signature = await signHandlerRequest(secret, raw);
    const headers = {
      'content-type': 'application/json',
      'duplexd-signature': signature,
      'duplexd-contract-version': String(fixture.contractVersion),
      'duplexd-session-id': String(fixture.sessionId),
    };

    // The delay the fixture asks the handler to take before its real answer.
    expect(fixture.consumerContext).toEqual({ sample: { delayMs: 3000 } });

    const timeToFirstByte = async (
      url: string,
    ): Promise<number | 'timed out'> => {
      const controller = new AbortController();
      const started = performance.now();
      const deadline = setTimeout(() => controller.abort(), 2_000);
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: raw,
          redirect: 'error',
          signal: controller.signal,
        });
        if (response.body === null) return 'timed out';
        const reader = response.body.getReader();
        const first = await reader.read();
        const elapsed = performance.now() - started;
        void reader.cancel();
        return first.done ? 'timed out' : elapsed;
      } catch {
        return 'timed out';
      } finally {
        clearTimeout(deadline);
      }
    };

    const referenceFirstByte = await timeToFirstByte(reference.url);
    expect(
      referenceFirstByte,
      'the reference handler withheld its keepalive',
    ).not.toBe('timed out');
    expect(referenceFirstByte).toBeLessThan(2_000);

    expect(
      await timeToFirstByte(buffering.url),
      'the buffering handler produced something before the deadline',
    ).toBe('timed out');
  }, 30_000);

  it('makes no timing claim in the scenarios without a delay', async () => {
    // Every other scenario passes against both handlers, which is only
    // possible if none of them infers buffering from read counts or chunking.
    const timingFree = CONFORMANCE_SCENARIOS.filter(
      (name) => name !== BUFFERING_ORACLE,
    );
    for (const name of timingFree) {
      const referenceResult = referenceReport.scenarios.find(
        (result) => result.name === name,
      );
      const bufferingResult = bufferingReport.scenarios.find(
        (result) => result.name === name,
      );
      expect(
        referenceResult?.passed,
        `${name} against the reference handler`,
      ).toBe(true);
      expect(
        bufferingResult?.passed,
        `${name} against the buffering handler`,
      ).toBe(true);
    }
  });
});

describe('the runner reports failures rather than throwing', () => {
  it('assembles a duplicate-header problem split across HTTP chunks', async () => {
    const remote = await startProblemServer([
      '{"code":"metadata_',
      'mismatch"}',
    ]);
    try {
      const report = await runConformance({
        url: remote.url,
        secret,
        scenarios: ['metadata-duplicate-header'],
      });
      expect(report.passed).toBe(true);
    } finally {
      await remote.close();
    }
  });

  it('turns malformed duplicate-header responses into a sanitized failure', async () => {
    const canary = 'SYNTHETIC_SECRET_CANARY_DO_NOT_PRINT';
    const remote = await startProblemServer([`not-json-${canary}`]);
    try {
      const report = await runConformance({
        url: remote.url,
        secret,
        scenarios: ['metadata-duplicate-header'],
      });
      expect(report.passed).toBe(false);
      expect(JSON.stringify(report)).not.toContain(canary);
      expect(report.scenarios[0]?.reason).toBe(
        'request failed without exposing remote diagnostics',
      );
    } finally {
      await remote.close();
    }
  });

  it('does not echo an untrusted problem code into the report', async () => {
    const canary = 'SYNTHETIC_SECRET_CANARY_DO_NOT_PRINT';
    const remote = await startProblemServer([JSON.stringify({ code: canary })]);
    try {
      const report = await runConformance({
        url: remote.url,
        secret,
        scenarios: ['metadata-mismatch-session'],
      });
      expect(report.passed).toBe(false);
      expect(JSON.stringify(report)).not.toContain(canary);
      expect(report.scenarios[0]?.reason).toContain('unexpected 400 response');
    } finally {
      await remote.close();
    }
  });

  it('turns an unreachable handler into a failed report', async () => {
    const dead = await startReferenceHandler(secret);
    const url = dead.url;
    await dead.close();

    const report = await runConformance({
      url,
      secret,
      scenarios: ['booking-request'],
    });
    expect(report.passed).toBe(false);
    expect(report.scenarios[0]?.reason).toBeTruthy();
    expect(report.scenarios[0]?.reason).not.toContain(secret);
  });

  it('turns a wrong secret into failed scenarios with readable reasons', async () => {
    const report = await runConformance({
      url: reference.url,
      secret: 'a-different-synthetic-secret',
      scenarios: ['booking-request', 'bad-signature'],
    });
    // The valid-stream scenario now fails; the bad-signature one still passes,
    // because a wrong secret is exactly what it sends on purpose.
    expect(
      report.scenarios.find((result) => result.name === 'booking-request')
        ?.passed,
    ).toBe(false);
    expect(
      report.scenarios.find((result) => result.name === 'bad-signature')
        ?.passed,
    ).toBe(true);
    expect(JSON.stringify(report)).not.toContain(
      'a-different-synthetic-secret',
    );
  });
});
