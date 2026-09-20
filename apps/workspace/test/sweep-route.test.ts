import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { secretsMatch, sweepStaleCalls } = vi.hoisted(() => ({
  secretsMatch: vi.fn((left: string, right: string) => left === right),
  sweepStaleCalls: vi.fn(),
}));
vi.mock('@/data/calls', () => ({ sweepStaleCalls }));
vi.mock('@/lib/crypto', () => ({ secretsMatch }));

import { POST } from '@/app/v1/internal/sweep/route';
import { authenticateSweep } from '@/control/sweep-auth';
import { hashCredential } from '@/lib/credentials';

const TOKEN = 'synthetic-sweep-token-for-tests';

function request(authorization?: string, query = ''): Request {
  return new Request(`http://localhost/v1/internal/sweep${query}`, {
    method: 'POST',
    headers: authorization === undefined ? {} : { authorization },
  });
}

describe('sweep authentication decision', () => {
  it.each([
    ['no header', null],
    ['an attacker-supplied header', `Bearer ${TOKEN}`],
  ] as const)(
    'refuses an unconfigured deployment with %s before comparison',
    (_label, header) => {
      secretsMatch.mockClear();
      expect(authenticateSweep(header, null)).toStrictEqual({
        ok: false,
        reason: 'sweep_not_configured',
      });
      expect(secretsMatch).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['missing header', null, 'missing_header'],
    ['malformed header', `Token ${TOKEN}`, 'malformed'],
    ['last-byte mismatch', `Bearer ${TOKEN.slice(0, -1)}x`, 'mismatch'],
  ] as const)('names the %s refusing check', (_label, header, reason) => {
    expect(authenticateSweep(header, TOKEN)).toStrictEqual({
      ok: false,
      reason,
    });
  });

  it('passes fixed-length digests to the shared comparator on acceptance', () => {
    secretsMatch.mockClear();
    expect(authenticateSweep(`Bearer ${TOKEN}`, TOKEN)).toStrictEqual({
      ok: true,
    });
    expect(secretsMatch).toHaveBeenCalledWith(
      hashCredential(TOKEN),
      hashCredential(TOKEN),
    );
  });

  it('passes fixed-length digests to the shared comparator for a near miss', () => {
    secretsMatch.mockClear();
    const nearMiss = `${TOKEN.slice(0, -1)}x`;
    expect(authenticateSweep(`Bearer ${nearMiss}`, TOKEN)).toStrictEqual({
      ok: false,
      reason: 'mismatch',
    });
    expect(secretsMatch).toHaveBeenCalledWith(
      hashCredential(nearMiss),
      hashCredential(TOKEN),
    );
  });
});

describe('sweep route', () => {
  beforeEach(() => {
    process.env.CALL_SWEEP_TOKEN = TOKEN;
    sweepStaleCalls.mockReset();
    sweepStaleCalls.mockResolvedValue({ incomplete: 2, failed: 1 });
  });

  afterEach(() => {
    delete process.env.CALL_SWEEP_TOKEN;
  });

  it.each([
    ['missing', undefined],
    ['malformed', `Token ${TOKEN}`],
    ['mismatch', `Bearer ${TOKEN.slice(0, -1)}x`],
  ])(
    'returns the same 401 for %s credentials without sweeping',
    async (_label, header) => {
      const response = await POST(request(header));
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        status: 401,
        code: 'invalid_sweep_token',
      });
      expect(sweepStaleCalls).not.toHaveBeenCalled();
    },
  );

  it('keeps an absent deployment token uniform externally and loud internally', async () => {
    const configured = await POST(request());
    const configuredText = await configured.text();
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    delete process.env.CALL_SWEEP_TOKEN;

    const unconfigured = await POST(request());
    const unconfiguredText = await unconfigured.text();

    expect(unconfigured.status).toBe(401);
    expect(unconfiguredText).toBe(configuredText);
    expect(log).toHaveBeenCalledWith(
      '[sweep] CALL_SWEEP_TOKEN is not configured; request refused.',
    );
    expect(sweepStaleCalls).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('ignores a query token and accepts only the bearer header', async () => {
    const rejected = await POST(request(undefined, `?token=${TOKEN}`));
    expect(rejected.status).toBe(401);
    expect(sweepStaleCalls).not.toHaveBeenCalled();

    const accepted = await POST(request(`Bearer ${TOKEN}`, '?token=wrong'));
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toStrictEqual({ incomplete: 2, failed: 1 });
    expect(sweepStaleCalls).toHaveBeenCalledOnce();
  });

  it('maps sweep failures to a secret-free error', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const canaries = [
      TOKEN,
      'postgres://database-canary.invalid/private',
      'encryption-key-canary',
      'transcript-canary-customer-words',
    ];
    sweepStaleCalls.mockRejectedValueOnce(
      new Error(`synthetic database failure ${canaries.join(' ')}`),
    );

    const response = await POST(request(`Bearer ${TOKEN}`));
    const text = await response.text();
    expect(response.status).toBe(500);
    expect(text).toContain('sweep_failed');
    expect(log).toHaveBeenCalledWith('[sweep] failed');
    const output = `${text}\n${log.mock.calls.flat().join('\n')}`;
    for (const canary of canaries) expect(output).not.toContain(canary);
    log.mockRestore();
  });
});
