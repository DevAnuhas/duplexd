import { describe, expect, it } from 'vitest';

import {
  DEFAULT_HANDLER_TIMEOUT_MS,
  HANDLER_URL_PATTERN,
  SessionConfig,
  SessionCreateRequest,
} from '@duplexd/contracts';

import {
  compileCommitted,
  loadSchemaCases,
  readCommittedSchema,
  SYNTHETIC_TEST_SECRET,
} from './support/fixtures.js';

const cases = loadSchemaCases().get('session.json') ?? [];
const sessionConfigCases = cases.filter((entry) => entry.schema === 'SessionConfig');
const createRequestCases = cases.filter((entry) => entry.schema === 'SessionCreateRequest');

const remoteHandler = {
  type: 'remote' as const,
  url: 'https://handler.example.com/delegations',
  auth: { type: 'hmac-sha256' as const, secret: SYNTHETIC_TEST_SECRET },
};
const base = {
  provider: 'openai-gpt-live' as const,
  instructions: 'Speak clearly and delegate when help is needed.',
};

/** `JSON.stringify({ pad })` frames the value in ten bytes: `{"pad":"…"}`. */
const CONTEXT_FRAME_BYTES = 10;
const asciiContext = (bytes: number) => ({ pad: 'x'.repeat(bytes - CONTEXT_FRAME_BYTES) });
const serializedBytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

describe('SessionConfig', () => {
  it('applies the default handler timeout when the field is omitted', () => {
    expect(SessionConfig.parse({ ...base, handler: remoteHandler }).handlerTimeoutMs).toBe(
      DEFAULT_HANDLER_TIMEOUT_MS,
    );
  });

  it('preserves an explicit handler timeout', () => {
    expect(
      SessionConfig.parse({ ...base, handlerTimeoutMs: 45000, handler: remoteHandler })
        .handlerTimeoutMs,
    ).toBe(45000);
  });

  it('accepts an in-process handler with no auth material', () => {
    const parsed = SessionConfig.parse({ ...base, handler: { type: 'in-process' } });
    expect(parsed.handler).toEqual({ type: 'in-process' });
  });

  it('marks the remote auth secret in schema metadata so redaction can find it', () => {
    // The marker lives on the Zod schema, discoverable by later redaction code.
    // It is deliberately absent from the emitted JSON Schema — the build strips
    // it so the portable artifact stays plain draft 2020-12 (asserted in
    // schema-equivalence.test.ts).
    const remote = SessionConfig.def.shape.handler.def.options[1];
    const secret = remote.def.shape.auth.def.shape.secret;
    expect(secret.meta()).toEqual({ secret: true });
  });

  it.each(sessionConfigCases)('$name', ({ value, expected }) => {
    expect(SessionConfig.safeParse(value).success).toBe(expected === 'valid');
  });
});

describe('SessionCreateRequest', () => {
  it.each(createRequestCases)('$name', ({ value, expected }) => {
    expect(SessionCreateRequest.safeParse(value).success).toBe(expected === 'valid');
  });

  it('is SessionConfig with only handler made optional', () => {
    const handlerless = { ...base };
    expect(SessionCreateRequest.safeParse(handlerless).success).toBe(true);
    expect(SessionConfig.safeParse(handlerless).success).toBe(false);
  });

  it('shares every non-handler field, bound and strictness with SessionConfig', () => {
    const shared: Array<[string, unknown]> = [
      ['instructions at the maximum', { ...base, instructions: 'i'.repeat(4000) }],
      ['instructions over the maximum', { ...base, instructions: 'i'.repeat(4001) }],
      ['timeout under the minimum', { ...base, handlerTimeoutMs: 999 }],
      ['timeout over the maximum', { ...base, handlerTimeoutMs: 120001 }],
      ['unknown top-level key', { ...base, extraTopLevel: true }],
      ['unknown nested audio key', { ...base, audio: { format: 'pcm16', extraNested: true } }],
      ['bad provider literal', { ...base, provider: 'anthropic-live' }],
    ];
    for (const [label, value] of shared) {
      const withHandler = { ...(value as object), handler: remoteHandler };
      expect(
        SessionCreateRequest.safeParse(value).success,
        `${label} diverged between the two schemas`,
      ).toBe(SessionConfig.safeParse(withHandler).success);
    }
  });

  it('infers the same defaulted timeout as SessionConfig', () => {
    expect(SessionCreateRequest.parse(base).handlerTimeoutMs).toBe(DEFAULT_HANDLER_TIMEOUT_MS);
  });

  it('applies the same handler rules when a handler is supplied', () => {
    expect(
      SessionCreateRequest.safeParse({
        ...base,
        handler: { ...remoteHandler, url: 'http://example.com' },
      }).success,
    ).toBe(false);
  });
});

describe('consumerContext serialized-byte bound', () => {
  // The one Zod-only constraint. Draft 2020-12 cannot express the serialized
  // UTF-8 byte length of an arbitrary JSON value, so both exported schemas
  // stay silent about it and native Zod carries the whole enforcement.
  const boundaryCases = cases.filter((entry) => entry.crossValidator === false);

  it('has a documented, asserted reason on every excluded case', () => {
    expect(boundaryCases.length).toBeGreaterThan(0);
    for (const entry of boundaryCases) {
      expect(entry.reason, `${entry.schema}/${entry.name} has no recorded reason`).toMatch(
        /serialized-UTF-8 byte length/,
      );
    }
  });

  it.each(['SessionConfig', 'SessionCreateRequest'] as const)(
    '%s accepts exactly 16384 serialized bytes and rejects 16385',
    (name) => {
      const schema = name === 'SessionConfig' ? SessionConfig : SessionCreateRequest;
      const withHandler = name === 'SessionConfig' ? { handler: remoteHandler } : {};

      const atBound = { ...base, ...withHandler, consumerContext: asciiContext(16384) };
      const overBound = { ...base, ...withHandler, consumerContext: asciiContext(16385) };
      expect(serializedBytes(atBound.consumerContext)).toBe(16384);
      expect(serializedBytes(overBound.consumerContext)).toBe(16385);

      expect(schema.safeParse(atBound).success).toBe(true);
      expect(schema.safeParse(overBound).success).toBe(false);
    },
  );

  it.each(['SessionConfig', 'SessionCreateRequest'] as const)(
    '%s counts UTF-8 bytes rather than JavaScript characters',
    (name) => {
      const schema = name === 'SessionConfig' ? SessionConfig : SessionCreateRequest;
      const withHandler = name === 'SessionConfig' ? { handler: remoteHandler } : {};
      // 5458 three-byte code points plus the ten-byte frame is exactly 16384
      // bytes, but only 5458 characters — a character count would let roughly
      // three times as much through.
      const context = { pad: '€'.repeat(5458) };
      expect(context.pad.length).toBe(5458);
      expect(serializedBytes(context)).toBe(16384);
      expect(schema.safeParse({ ...base, ...withHandler, consumerContext: context }).success).toBe(
        true,
      );

      const over = { pad: `${'€'.repeat(5458)}x` };
      expect(serializedBytes(over)).toBe(16385);
      expect(schema.safeParse({ ...base, ...withHandler, consumerContext: over }).success).toBe(
        false,
      );
    },
  );

  it('neither exported schema emits a size keyword for consumerContext', () => {
    for (const file of ['SessionConfig.json', 'SessionCreateRequest.json'] as const) {
      // Read the committed artifact, not the live Zod schema.
      const text = JSON.stringify(readCommittedSchema(file));
      for (const fake of [
        'maxBytes',
        'maxSerializedBytes',
        'maxByteLength',
        'x-maxBytes',
        'consumerContextBytes',
        '16384',
      ]) {
        expect(text, `${file} smuggles a fake size keyword: ${fake}`).not.toContain(fake);
      }
    }
  });
});

describe('handler URL rule', () => {
  const urlCases = sessionConfigCases.filter((entry) => entry.name.startsWith('handler url '));
  const validator = compileCommitted('SessionConfig');

  it('covers the whole enumerated matrix in one place', () => {
    const accepted = urlCases.filter((entry) => entry.expected === 'valid');
    const rejected = urlCases.filter((entry) => entry.expected === 'invalid');
    expect(accepted.length).toBeGreaterThanOrEqual(9);
    expect(rejected.length).toBeGreaterThanOrEqual(15);

    // The named cases the spec and the plan's correction both call out.
    const rejectedUrls = rejected.map((entry) => entry.name);
    for (const required of [
      'http://example.com',
      'http://LOCALHOST',
      'https://user:pw@handler.example.com',
      'https://handler.example.com/#fragment',
      'https://exa mple.com',
      '/delegations',
      'https://:',
      'https://handler.example.com:abc',
      'https://[garbage',
    ]) {
      expect(
        rejectedUrls.some((name) => name.includes(required)),
        `the URL matrix never rejects ${required}`,
      ).toBe(true);
    }
  });

  it.each(urlCases)('$name', ({ value, expected }) => {
    const url = (value as { handler: { url: string } }).handler.url;
    const shouldMatch = expected === 'valid';

    // Three views of the same rule: the raw regex, the Zod schema, and the
    // committed JSON Schema a non-TypeScript consumer would compile.
    expect(HANDLER_URL_PATTERN.test(url)).toBe(shouldMatch);
    expect(SessionConfig.safeParse(value).success).toBe(shouldMatch);
    expect(validator(value)).toBe(shouldMatch);
  });
});
