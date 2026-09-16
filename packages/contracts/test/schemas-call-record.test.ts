import { describe, expect, it } from 'vitest';

import { CallRecord, CONTRACT_VERSION } from '@duplexd/contracts';

import { loadSchemaCases, SYNTHETIC_TEST_SECRET } from './support/fixtures.js';

const cases = loadSchemaCases().get('call-record.json') ?? [];
const closed = cases.find((entry) => entry.name === 'closed record')?.value as Record<
  string,
  unknown
>;

/** Drop keys without a throwaway binding ESLint would flag as unused. */
const without = (source: Record<string, unknown>, ...keys: string[]): Record<string, unknown> =>
  Object.fromEntries(Object.entries(source).filter(([key]) => !keys.includes(key)));

describe('CallRecord', () => {
  it.each(cases)('$name', ({ value, expected }) => {
    expect(CallRecord.safeParse(value).success).toBe(expected === 'valid');
  });

  it('encodes all three terminal states', () => {
    const states = cases
      .filter((entry) => entry.expected === 'valid')
      .map((entry) => (entry.value as { state: string }).state);
    expect(new Set(states)).toEqual(new Set(['closed', 'failed', 'incomplete']));
  });

  it('carries optional usage only on a closed record', () => {
    // The spec says usage is optional and "present only when state is closed".
    // The schema encodes that as a state-discriminated union rather than a
    // comment: optional on the closed branch, absent from the other two.
    const withoutUsage = without(closed, 'usage');
    expect(CallRecord.safeParse(closed).success).toBe(true);
    expect(CallRecord.safeParse(withoutUsage).success).toBe(true);
    for (const state of ['failed', 'incomplete']) {
      expect(CallRecord.safeParse({ ...closed, state }).success, `${state} with usage`).toBe(false);
      expect(
        CallRecord.safeParse({ ...withoutUsage, state }).success,
        `${state} without usage`,
      ).toBe(true);
    }
  });

  it('stores the handler without any auth material', () => {
    const parsed = CallRecord.parse(closed);
    expect(parsed.handler).toEqual({ type: 'remote', url: 'https://handler.example.com/delegations' });
    expect(
      CallRecord.safeParse({
        ...closed,
        handler: {
          type: 'remote',
          url: 'https://handler.example.com/delegations',
          auth: { type: 'hmac-sha256', secret: SYNTHETIC_TEST_SECRET },
        },
      }).success,
    ).toBe(false);
  });

  it('has no place to put a secret or consumer context', () => {
    const keys = CallRecord.def.options.flatMap((option) => Object.keys(option.def.shape));
    for (const forbidden of ['consumerContext', 'secret', 'auth', 'signature']) {
      expect(keys, `CallRecord exposes ${forbidden}`).not.toContain(forbidden);
    }
    expect(CallRecord.safeParse({ ...closed, consumerContext: { tenant: 'acme' } }).success).toBe(
      false,
    );
  });

  it('pins the contract version literal', () => {
    expect(closed.contractVersion).toBe(CONTRACT_VERSION);
    expect(CallRecord.safeParse({ ...closed, contractVersion: '2' }).success).toBe(false);
  });

  it('requires createdAt and endedAt but leaves startedAt optional', () => {
    for (const required of ['createdAt', 'endedAt']) {
      expect(
        CallRecord.safeParse(without(closed, required)).success,
        `${required} should be required`,
      ).toBe(false);
    }
    expect(CallRecord.safeParse(without(closed, 'startedAt')).success).toBe(true);
  });

  it('records sent and rejected appends separately, each with its own reasons', () => {
    const parsed = CallRecord.parse(closed);
    expect(parsed.appends.map((append) => append.delegationId)).toEqual([
      'delegation_fixture_1',
      null,
    ]);
    expect(parsed.rejectedAppends[0]?.reason).toBe('over_budget');
    expect(
      CallRecord.safeParse({
        ...closed,
        rejectedAppends: [{ ...(closed.rejectedAppends as unknown[])[0] as object, reason: 'vibes' }],
      }).success,
    ).toBe(false);
  });

  it('invents no identifier field of its own', () => {
    const keys = new Set(CallRecord.def.options.flatMap((option) => Object.keys(option.def.shape)));
    for (const invented of ['id', 'recordId', 'callId', 'uuid', 'pk', 'droppedItems']) {
      expect([...keys], `CallRecord invents ${invented}`).not.toContain(invented);
    }
    // The provider's session id is the primary key.
    expect(keys.has('sessionId')).toBe(true);
  });
});
