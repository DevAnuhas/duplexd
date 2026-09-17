import { describe, expect, it } from 'vitest';

import { CoreEvent } from '@duplexd/contracts';

import { loadSchemaCases } from './support/fixtures.js';

const cases = loadSchemaCases().get('core-event.json') ?? [];

/** Every discriminator the spec names. A missing one fails the inventory. */
const EVENT_TYPES = [
  'session.started',
  'session.closing',
  'session.closed',
  'session.failed',
  'session.incomplete',
  'transcript.user.delta',
  'transcript.assistant.delta',
  'delegation.created',
  'delegation.finished',
  'append.sent',
  'append.rejected',
  'transport.dtmf',
  'provider.raw',
] as const;

const event = (type: string, payload: unknown, overrides: Record<string, unknown> = {}) => ({
  type,
  sessionId: 'session_fixture_1',
  seq: 1,
  at: '2026-01-01T00:00:00.000Z',
  payload,
  ...overrides,
});

describe('CoreEvent', () => {
  it('is a discriminated union over exactly the spec event types', () => {
    expect(CoreEvent.def.options.map((option) => option.def.shape.type.def.values[0]).sort()).toEqual(
      [...EVENT_TYPES].sort(),
    );
  });

  it.each(EVENT_TYPES)('the fixture inventory covers %s', (type) => {
    expect(
      cases.some((entry) => (entry.value as { type: string }).type === type && entry.expected === 'valid'),
      `no valid CoreEvent fixture for ${type}`,
    ).toBe(true);
  });

  it.each(cases)('$name', ({ value, expected }) => {
    expect(CoreEvent.safeParse(value).success).toBe(expected === 'valid');
  });

  it('enforces the common envelope on every variant', () => {
    for (const type of EVENT_TYPES) {
      const valid = cases.find(
        (entry) => (entry.value as { type: string }).type === type && entry.expected === 'valid',
      );
      const payload = (valid?.value as { payload: unknown }).payload;
      expect(CoreEvent.safeParse(event(type, payload, { seq: 0 })).success, `${type} seq 0`).toBe(
        false,
      );
      expect(
        CoreEvent.safeParse(event(type, payload, { sessionId: '' })).success,
        `${type} empty sessionId`,
      ).toBe(false);
      expect(
        CoreEvent.safeParse(event(type, payload, { at: 'not-a-timestamp' })).success,
        `${type} bad at`,
      ).toBe(false);
      expect(
        CoreEvent.safeParse(event(type, payload, { extraTopLevel: true })).success,
        `${type} unknown top-level key`,
      ).toBe(false);
    }
  });

  it('accepts every session.incomplete reason including instance_lost', () => {
    for (const reason of [
      'provider_disconnected',
      'provider_final_event_missing',
      'process_shutdown',
      'instance_lost',
    ]) {
      expect(CoreEvent.safeParse(event('session.incomplete', { reason })).success).toBe(true);
    }
  });

  it('allows a null delegation id on both append events', () => {
    expect(
      CoreEvent.safeParse(
        event('append.sent', { delegationId: null, kind: 'commentary', tokens: 1 }),
      ).success,
    ).toBe(true);
    expect(
      CoreEvent.safeParse(
        event('append.rejected', { delegationId: null, kind: 'commentary', reason: 'over_budget' }),
      ).success,
    ).toBe(true);
  });

  it('keeps delegation.finished error optional and running out of reach', () => {
    const base = { delegationId: 'delegation_fixture_1' };
    expect(CoreEvent.safeParse(event('delegation.finished', { ...base, outcome: 'done' })).success).toBe(
      true,
    );
    expect(
      CoreEvent.safeParse(
        event('delegation.finished', { ...base, outcome: 'error', error: 'boom' }),
      ).success,
    ).toBe(true);
    // `running` is a prior-delegation outcome, not a finished one.
    expect(
      CoreEvent.safeParse(event('delegation.finished', { ...base, outcome: 'running' })).success,
    ).toBe(false);
  });

  it('carries arbitrary recursive JSON in provider.raw', () => {
    for (const raw of [null, 1, 'x', true, [], {}, { a: [1, { b: [null, 'c'] }] }]) {
      expect(
        CoreEvent.safeParse(event('provider.raw', { event: raw })).success,
        `provider.raw rejected ${JSON.stringify(raw)}`,
      ).toBe(true);
    }
  });

  it('has no droppedItems field anywhere', () => {
    expect(JSON.stringify(cases)).not.toContain('droppedItems');
  });
});
