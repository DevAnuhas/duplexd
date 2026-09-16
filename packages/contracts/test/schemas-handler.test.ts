import { describe, expect, it } from 'vitest';

import {
  CONTRACT_VERSION,
  HandlerRequestLoose,
  HandlerRequestStrict,
  HandlerResult,
  MAX_CONTENT_CHARS,
  handlerRequestSchema,
} from '@duplexd/contracts';

import { loadRequestFixtures, loadSchemaCases } from './support/fixtures.js';

const requests = loadRequestFixtures();
const booking = requests.get('booking');
if (booking === undefined) throw new Error('fixtures/requests/booking.json is missing');

const resultCases = loadSchemaCases().get('handler-result.json') ?? [];

/** Deep clone so a mutation in one test cannot leak into the next. */
const clone = <T>(value: T): T => structuredClone(value);

describe('HandlerRequest strict and loose', () => {
  it('are produced by one mode-parameterized factory', () => {
    // Both named exports must be the factory's output, not two hand-written
    // schemas that could drift apart on a known key.
    expect(handlerRequestSchema('strict').def.catchall).toEqual(HandlerRequestStrict.def.catchall);
    expect(handlerRequestSchema('loose').def.catchall).toEqual(HandlerRequestLoose.def.catchall);
    expect(Object.keys(handlerRequestSchema('strict').def.shape)).toEqual(
      Object.keys(HandlerRequestStrict.def.shape),
    );
    expect(Object.keys(handlerRequestSchema('loose').def.shape)).toEqual(
      Object.keys(HandlerRequestLoose.def.shape),
    );
  });

  it.each([...requests])('%s matches its recorded strict expectation', (_name, fixture) => {
    expect(HandlerRequestStrict.safeParse(fixture.request).success).toBe(
      fixture.expected.strict === 'valid',
    );
  });

  it.each([...requests])('%s matches its recorded loose expectation', (_name, fixture) => {
    expect(HandlerRequestLoose.safeParse(fixture.request).success).toBe(
      fixture.expected.loose === 'valid',
    );
  });

  it('carries the literal contract version', () => {
    expect(booking.request.contractVersion).toBe(CONTRACT_VERSION);
    const wrongVersion = { ...clone(booking.request), contractVersion: '0' };
    expect(HandlerRequestStrict.safeParse(wrongVersion).success).toBe(false);
    expect(HandlerRequestLoose.safeParse(wrongVersion).success).toBe(false);
  });

  it('requires non-empty opaque session and delegation ids', () => {
    for (const key of ['sessionId', 'delegationId']) {
      const empty = { ...clone(booking.request), [key]: '' };
      expect(HandlerRequestStrict.safeParse(empty).success, `${key} empty`).toBe(false);
      expect(HandlerRequestLoose.safeParse(empty).success, `${key} empty`).toBe(false);
    }
  });

  it('requires non-negative integer offsets at both levels', () => {
    for (const bad of [-1, 1.5, '1200']) {
      expect(HandlerRequestStrict.safeParse({ ...clone(booking.request), offsetMs: bad }).success).toBe(
        false,
      );
      const transcript = clone(booking.request).transcript as Array<Record<string, unknown>>;
      const fragment = transcript[0];
      if (fragment !== undefined) fragment.offsetMs = bad;
      expect(
        HandlerRequestStrict.safeParse({ ...clone(booking.request), transcript }).success,
      ).toBe(false);
    }
  });

  it('accepts every prior-delegation outcome including running', () => {
    for (const outcome of ['done', 'timeout', 'cancelled', 'error', 'running']) {
      const request = {
        ...clone(booking.request),
        priorDelegations: [{ delegationId: 'delegation_prior', outcome }],
      };
      expect(HandlerRequestStrict.safeParse(request).success, outcome).toBe(true);
    }
    expect(
      HandlerRequestStrict.safeParse({
        ...clone(booking.request),
        priorDelegations: [{ delegationId: 'd', outcome: 'vibes' }],
      }).success,
    ).toBe(false);
  });

  it('rejects unknown keys at every contract-owned nested level under strict', () => {
    const mutations: Array<[string, Record<string, unknown>]> = [
      ['top level', { ...clone(booking.request), extraTopLevel: true }],
      [
        'transcript fragment',
        {
          ...clone(booking.request),
          transcript: [{ role: 'user', text: 'x', offsetMs: 0, extraNested: true }],
        },
      ],
      [
        'prior delegation',
        {
          ...clone(booking.request),
          priorDelegations: [{ delegationId: 'd', outcome: 'done', extraNested: true }],
        },
      ],
    ];
    for (const [where, request] of mutations) {
      expect(HandlerRequestStrict.safeParse(request).success, `strict tolerated ${where}`).toBe(false);
      expect(HandlerRequestLoose.safeParse(request).success, `loose rejected ${where}`).toBe(true);
    }
  });

  it('validates every known key identically in both modes', () => {
    const breakages: Array<Record<string, unknown>> = [
      { ...clone(booking.request), sessionId: 42 },
      { ...clone(booking.request), transcript: [{ role: 'narrator', text: 'x', offsetMs: 0 }] },
      { ...clone(booking.request), transcript: 'not-an-array' },
      { ...clone(booking.request), priorDelegations: [{ delegationId: '', outcome: 'done' }] },
      { ...clone(booking.request), offsetMs: -1 },
    ];
    for (const request of breakages) {
      expect(HandlerRequestStrict.safeParse(request).success).toBe(false);
      expect(HandlerRequestLoose.safeParse(request).success).toBe(false);
    }
  });

  it('leaves consumerContext as arbitrary JSON in both modes and re-checks no size', () => {
    // It echoes an already-validated SessionConfig value, so there is
    // deliberately no per-delegation byte bound to trip over.
    const huge = { pad: 'x'.repeat(40_000), nested: [1, null, { deep: true }] };
    for (const schema of [HandlerRequestStrict, HandlerRequestLoose]) {
      expect(schema.safeParse({ ...clone(booking.request), consumerContext: huge }).success).toBe(
        true,
      );
      expect(schema.safeParse({ ...clone(booking.request), consumerContext: null }).success).toBe(
        true,
      );
      expect(schema.safeParse({ ...clone(booking.request), consumerContext: 7 }).success).toBe(true);
    }
  });

  it('has no task-text field anywhere in the request shape', () => {
    const keys = Object.keys(HandlerRequestStrict.def.shape);
    expect(keys).toEqual([
      'contractVersion',
      'sessionId',
      'delegationId',
      'offsetMs',
      'transcript',
      'consumerContext',
      'priorDelegations',
    ]);
    for (const forbidden of ['task', 'taskText', 'text', 'prompt', 'instruction']) {
      expect(keys).not.toContain(forbidden);
    }
  });
});

describe('HandlerResult', () => {
  it('is the five-variant union', () => {
    expect(
      HandlerResult.def.options.map((option) => option.def.shape.kind.def.values[0]).sort(),
    ).toEqual(['commentary', 'done', 'error', 'instruction', 'thinking']);
  });

  it.each(resultCases)('$name', ({ value, expected }) => {
    expect(HandlerResult.safeParse(value).success).toBe(expected === 'valid');
  });

  it.each(['thinking', 'commentary', 'instruction'] as const)(
    '%s accepts exactly MAX_CONTENT_CHARS and rejects one more',
    (kind) => {
      expect(HandlerResult.safeParse({ kind, content: 'c'.repeat(MAX_CONTENT_CHARS) }).success).toBe(
        true,
      );
      expect(
        HandlerResult.safeParse({ kind, content: 'c'.repeat(MAX_CONTENT_CHARS + 1) }).success,
      ).toBe(false);
    },
  );

  it('tolerates extra fields on a known kind and rejects an unknown kind', () => {
    expect(HandlerResult.safeParse({ kind: 'done', extra: 1, more: { deep: true } }).success).toBe(
      true,
    );
    expect(HandlerResult.safeParse({ kind: 'mystery', content: 'x' }).success).toBe(false);
  });

  it('gives done no required fields and error a required message', () => {
    expect(HandlerResult.safeParse({ kind: 'done' }).success).toBe(true);
    expect(HandlerResult.safeParse({ kind: 'error' }).success).toBe(false);
    expect(HandlerResult.safeParse({ kind: 'error', message: 'upstream failed' }).success).toBe(true);
  });
});
