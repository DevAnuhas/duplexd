import { describe, expect, it } from 'vitest';

import {
  AppendKindSchema,
  IsoTimestampSchema,
  JsonValueSchema,
  TranscriptFragmentSchema,
  UsageSchema,
} from '@duplexd/contracts';

describe('JsonValue', () => {
  it.each([
    ['null', null],
    ['true', true],
    ['false', false],
    ['zero', 0],
    ['negative float', -1.5],
    ['empty string', ''],
    ['string', 'x'],
    ['empty array', []],
    ['empty object', {}],
    ['nested array', [1, 'a', null, [true, {}]]],
    ['nested object', { a: { b: { c: [1, null, 'd'] } } }],
    [
      'deeply recursive',
      { l1: { l2: { l3: { l4: { l5: [[[{ l9: null }]]] } } } } },
    ],
  ])('accepts %s', (_label, value) => {
    expect(JsonValueSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    ['undefined', undefined],
    ['a function', () => undefined],
    ['a symbol', Symbol('nope')],
    ['a bigint', 10n],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a Date', new Date()],
    ['a Map', new Map()],
  ])('rejects %s at the top level', (_label, value) => {
    expect(JsonValueSchema.safeParse(value).success).toBe(false);
  });

  it.each([
    ['undefined', undefined],
    ['a function', () => undefined],
    ['a symbol', Symbol('nope')],
    ['a bigint', 10n],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('rejects %s nested inside an array', (_label, value) => {
    expect(JsonValueSchema.safeParse([1, [2, [value]]]).success).toBe(false);
  });

  it.each([
    ['undefined', undefined],
    ['a function', () => undefined],
    ['a bigint', 10n],
    ['NaN', Number.NaN],
  ])('rejects %s nested inside an object', (_label, value) => {
    expect(JsonValueSchema.safeParse({ a: { b: { c: value } } }).success).toBe(
      false,
    );
  });

  it('only accepts string-keyed objects', () => {
    expect(JsonValueSchema.safeParse({ ok: 'yes' }).success).toBe(true);
    // A symbol key is not JSON, so the record schema refuses it rather than
    // quietly dropping it the way `JSON.stringify` would.
    expect(
      JsonValueSchema.safeParse({ [Symbol('s')]: 1, ok: 'yes' }).success,
    ).toBe(false);
    expect(
      JsonValueSchema.safeParse({ ok: 'yes', bad: undefined }).success,
    ).toBe(false);
  });
});

describe('AppendKind', () => {
  it('is exactly the three append kinds', () => {
    expect(AppendKindSchema.options).toEqual([
      'thinking',
      'commentary',
      'instruction',
    ]);
    expect(AppendKindSchema.safeParse('commentary').success).toBe(true);
    expect(AppendKindSchema.safeParse('speech').success).toBe(false);
  });
});

describe('Usage', () => {
  it('requires non-negative seconds and arbitrary raw JSON', () => {
    expect(UsageSchema.safeParse({ seconds: 0, raw: null }).success).toBe(true);
    expect(
      UsageSchema.safeParse({ seconds: 12.5, raw: { tier: 'test' } }).success,
    ).toBe(true);
    expect(UsageSchema.safeParse({ seconds: -1, raw: {} }).success).toBe(false);
    expect(UsageSchema.safeParse({ seconds: 1 }).success).toBe(false);
    expect(
      UsageSchema.safeParse({ seconds: 1, raw: {}, extraNested: true }).success,
    ).toBe(false);
  });
});

describe('TranscriptFragment', () => {
  it('pins role, text and a non-negative integer offset', () => {
    expect(
      TranscriptFragmentSchema.safeParse({
        role: 'user',
        text: '',
        offsetMs: 0,
      }).success,
    ).toBe(true);
    expect(
      TranscriptFragmentSchema.safeParse({
        role: 'assistant',
        text: 'x',
        offsetMs: 900,
      }).success,
    ).toBe(true);
    expect(
      TranscriptFragmentSchema.safeParse({
        role: 'narrator',
        text: 'x',
        offsetMs: 0,
      }).success,
    ).toBe(false);
    expect(
      TranscriptFragmentSchema.safeParse({
        role: 'user',
        text: 'x',
        offsetMs: -1,
      }).success,
    ).toBe(false);
    expect(
      TranscriptFragmentSchema.safeParse({
        role: 'user',
        text: 'x',
        offsetMs: 1.5,
      }).success,
    ).toBe(false);
    expect(
      TranscriptFragmentSchema.safeParse({
        role: 'user',
        text: 'x',
        offsetMs: 0,
        extra: 1,
      }).success,
    ).toBe(false);
  });
});

describe('IsoTimestamp', () => {
  it.each([
    '2026-01-01T00:00:00Z',
    '2026-01-01T00:00:00.000Z',
    '2026-01-01T00:00:00.123456789Z',
    '2026-01-01T00:00:00+05:30',
    '2026-01-01T00:00:00-08:00',
    '2024-02-29T23:59:59+23:59',
  ])('accepts %s', (value) => {
    expect(IsoTimestampSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    '2026-01-01',
    '2026-01-01T00:00:00',
    'yesterday',
    '',
    '2026-01-01 00:00:00Z',
    '2026-01-01T00:00:00.Z',
    '2026-99-99T88:88:88Z',
    '2026-02-30T12:00:00Z',
    '2026-01-01T00:00:00+99:99',
    '2025-02-29T12:00:00Z',
  ])('rejects %s', (value) => {
    expect(IsoTimestampSchema.safeParse(value).success).toBe(false);
  });
});
