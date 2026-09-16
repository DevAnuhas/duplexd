import { describe, expect, it } from 'vitest';

import {
  APPEND_TOKEN_BUDGET,
  CONTRACT_VERSION,
  DEFAULT_HANDLER_TIMEOUT_MS,
  HANDLER_URL_PATTERN,
  MAX_CONTENT_CHARS,
  MAX_HANDLER_TIMEOUT_MS,
  MAX_NDJSON_LINE_BYTES,
  MIN_HANDLER_TIMEOUT_MS,
  SCHEMA_DRAFT,
  SIGNATURE_TOLERANCE_SECONDS,
} from '@duplexd/contracts';

import { readCommittedSchema } from './support/fixtures.js';

/**
 * The corrected handler URL regex from the T02 plan, quoted byte-for-byte.
 *
 * This literal is deliberately a duplicate of `constants.ts` rather than an
 * import: the whole point is to catch a silent edit to the pattern, which an
 * import would happily follow. The plan's correction narrowed the host class
 * to exclude `:`, `[` and `]`, so `https://:`, `https://host:abc` and
 * `https://[garbage` stop matching.
 */
const EXPECTED_HANDLER_URL_SOURCE =
  '^(?:https:\\/\\/(?:\\[[0-9a-fA-F:]+\\]|[^\\s@/?#:[\\]]+)(?::[0-9]+)?(?:[/?][^\\s#]*)?|http:\\/\\/(?:localhost|127\\.0\\.0\\.1|\\[::1\\])(?::[0-9]+)?(?:[/?][^\\s#]*)?)$';

describe('contract constants', () => {
  it('exports exactly the values the spec names', () => {
    expect(CONTRACT_VERSION).toBe('1');
    expect(APPEND_TOKEN_BUDGET).toBe(500);
    expect(MAX_CONTENT_CHARS).toBe(500);
    expect(DEFAULT_HANDLER_TIMEOUT_MS).toBe(30000);
    expect(MIN_HANDLER_TIMEOUT_MS).toBe(1000);
    expect(MAX_HANDLER_TIMEOUT_MS).toBe(120000);
    expect(SIGNATURE_TOLERANCE_SECONDS).toBe(300);
    expect(MAX_NDJSON_LINE_BYTES).toBe(65536);
    expect(SCHEMA_DRAFT).toBe('https://json-schema.org/draft/2020-12/schema');
  });

  it('keeps the default handler timeout inside its own bounds', () => {
    expect(MIN_HANDLER_TIMEOUT_MS).toBeLessThan(DEFAULT_HANDLER_TIMEOUT_MS);
    expect(DEFAULT_HANDLER_TIMEOUT_MS).toBeLessThan(MAX_HANDLER_TIMEOUT_MS);
  });

  it('carries the corrected handler URL pattern byte-for-byte', () => {
    expect(HANDLER_URL_PATTERN.source).toBe(EXPECTED_HANDLER_URL_SOURCE);
    expect(HANDLER_URL_PATTERN.flags).toBe('');
  });
});

describe('schema/constants.json', () => {
  const portable = readCommittedSchema('constants.json');

  it('is generated from constants.ts rather than separately maintained', () => {
    expect(portable).toEqual({
      APPEND_TOKEN_BUDGET,
      CONTRACT_VERSION,
      DEFAULT_HANDLER_TIMEOUT_MS,
      HANDLER_URL_PATTERN: HANDLER_URL_PATTERN.source,
      MAX_CONTENT_CHARS,
      MAX_HANDLER_TIMEOUT_MS,
      MAX_NDJSON_LINE_BYTES,
      MIN_HANDLER_TIMEOUT_MS,
      SCHEMA_DRAFT,
      SIGNATURE_TOLERANCE_SECONDS,
    });
  });

  it('carries every portable constant a non-TypeScript consumer needs', () => {
    // The Python handler reads these from the file instead of a comment.
    for (const key of [
      'CONTRACT_VERSION',
      'APPEND_TOKEN_BUDGET',
      'MAX_CONTENT_CHARS',
      'MIN_HANDLER_TIMEOUT_MS',
      'DEFAULT_HANDLER_TIMEOUT_MS',
      'MAX_HANDLER_TIMEOUT_MS',
      'SIGNATURE_TOLERANCE_SECONDS',
      'MAX_NDJSON_LINE_BYTES',
      'HANDLER_URL_PATTERN',
    ]) {
      expect(portable, `constants.json is missing ${key}`).toHaveProperty(key);
    }
  });

  it('carries the URL pattern in a form another language can compile', () => {
    expect(portable.HANDLER_URL_PATTERN).toBe(EXPECTED_HANDLER_URL_SOURCE);
    expect(new RegExp(String(portable.HANDLER_URL_PATTERN)).test('https://example.com')).toBe(true);
  });
});
