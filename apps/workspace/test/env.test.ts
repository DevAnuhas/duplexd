import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { validateServerUrl } from '@/lib/validate';

import {
  requireAuthSecret,
  requireAuthUrl,
  requireDatabaseUrl,
  requireEncryptionKey,
  requirePipecatApiKey,
} from '@/db/env';

/**
 * The fail-closed environment guards.
 *
 * `DATABASE_URL` is the sharp one. `psql` and libpq-style clients treat an empty
 * connection argument as "use the defaults" and connect to the local unix socket
 * on 5432 — so an empty variable does not fail, it quietly talks to whatever
 * database happens to be running on the machine. That has already fired in this
 * repository once, when a `.env` line broke shell parsing and left the variable
 * empty. Every case below is a way that variable can arrive not-set.
 *
 * The host is deliberately never asserted on. A Neon branch is the documented
 * default and any PostgreSQL 17 or newer works; a guard that rejected a local
 * server would contradict that, so the tests check for "absent", never "wrong
 * kind of database".
 */

const VARIABLES = [
  'DATABASE_URL',
  'ASSISTANT_SECRET_KEY',
  'BETTER_AUTH_SECRET',
  'BETTER_AUTH_URL',
  'PIPECAT_API_KEY',
] as const;

/**
 * Documented in `.env.example`, read directly, and deliberately unguarded.
 *
 * Each one must be **absent-safe**: unset has to mean the safe behaviour, not
 * an error and not the permissive behaviour. That is what justifies it having
 * no `require…()` guard, and it is asserted rather than asserted about — see
 * the absent-safe test below.
 */
const OPTIONAL_VARIABLES = ['ALLOW_LOOPBACK_SERVER_URL'] as const;

describe('environment guards', () => {
  let saved: Partial<Record<(typeof VARIABLES)[number], string | undefined>> = {};

  beforeEach(() => {
    saved = Object.fromEntries(VARIABLES.map((name) => [name, process.env[name]]));
  });

  afterEach(() => {
    for (const name of VARIABLES) {
      const value = saved[name];

      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  describe('requireDatabaseUrl', () => {
    it.each([
      ['unset', undefined],
      ['the empty string', ''],
      ['only whitespace', '   '],
    ])('throws when DATABASE_URL is %s', (_label, value) => {
      if (value === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = value;
      }

      expect(() => requireDatabaseUrl()).toThrow(/DATABASE_URL/);
    });

    it('names the variable and says it is never defaulted', () => {
      delete process.env.DATABASE_URL;

      expect(() => requireDatabaseUrl()).toThrow(/DATABASE_URL/);
      expect(() => requireDatabaseUrl()).toThrow(/unset or empty/i);
    });

    it('returns the value when it is set', () => {
      process.env.DATABASE_URL = 'postgres://example.invalid:5432/db';

      expect(requireDatabaseUrl()).toBe('postgres://example.invalid:5432/db');
    });

    /**
     * A local server is a legitimate configuration, so this must not be
     * rejected. The Planner's ruling: any PostgreSQL 17+ works and nothing
     * special-cases Neon, which means nothing may special-case localhost either.
     */
    it('accepts a local connection string rather than inspecting the host', () => {
      process.env.DATABASE_URL = 'postgres://localhost:5432/anything';

      expect(requireDatabaseUrl()).toBe('postgres://localhost:5432/anything');
    });
  });

  describe('requireEncryptionKey', () => {
    it.each([
      ['unset', undefined],
      ['the empty string', ''],
      ['only whitespace', '  '],
    ])('throws when ASSISTANT_SECRET_KEY is %s', (_label, value) => {
      if (value === undefined) {
        delete process.env.ASSISTANT_SECRET_KEY;
      } else {
        process.env.ASSISTANT_SECRET_KEY = value;
      }

      expect(() => requireEncryptionKey()).toThrow(/ASSISTANT_SECRET_KEY/);
    });

    it.each([
      ['63 hex characters', 'a'.repeat(63)],
      ['65 hex characters', 'a'.repeat(65)],
      ['32 raw bytes rather than hex', 'x'.repeat(32)],
      ['non-hex characters', 'g'.repeat(64)],
    ])('throws when the key is %s', (_label, value) => {
      process.env.ASSISTANT_SECRET_KEY = value;

      expect(() => requireEncryptionKey()).toThrow(/ASSISTANT_SECRET_KEY/);
    });

    it('returns 32 bytes for a valid key', () => {
      process.env.ASSISTANT_SECRET_KEY = 'ab'.repeat(32);

      const key = requireEncryptionKey();

      expect(key).toHaveLength(32);
      expect(key.toString('hex')).toBe('ab'.repeat(32));
    });

    it('accepts upper-case hex and surrounding whitespace', () => {
      process.env.ASSISTANT_SECRET_KEY = `  ${'AB'.repeat(32)}  `;

      expect(requireEncryptionKey().toString('hex')).toBe('ab'.repeat(32));
    });

    /** A default key is the same as no encryption, and harder to notice. */
    it('never falls back to a default key', () => {
      delete process.env.ASSISTANT_SECRET_KEY;

      expect(() => requireEncryptionKey()).toThrow();
    });
  });

  describe('requireAuthSecret', () => {
    it.each([
      ['unset', undefined],
      ['the empty string', ''],
      ['only whitespace', ' '],
    ])('throws when BETTER_AUTH_SECRET is %s', (_label, value) => {
      if (value === undefined) {
        delete process.env.BETTER_AUTH_SECRET;
      } else {
        process.env.BETTER_AUTH_SECRET = value;
      }

      expect(() => requireAuthSecret()).toThrow(/BETTER_AUTH_SECRET/);
    });

    it('returns the value when it is set', () => {
      process.env.BETTER_AUTH_SECRET = 'placeholder-value-for-this-test';

      expect(requireAuthSecret()).toBe('placeholder-value-for-this-test');
    });
  });

  /**
   * `BETTER_AUTH_URL` is required rather than optional, and the reason is worth
   * stating because the optional version looks harmless.
   *
   * Better Auth will derive its base URL from the incoming request when this is
   * absent. That hands the origin used to build callback and cookie URLs to
   * whatever `Host` header arrives — and behind a proxy, which is exactly how
   * this deploys, the application does not control that header. A deployment
   * should state its own identity rather than infer it from traffic.
   *
   * It is also what keeps `.env.example` honest under contract item 19: every
   * variable listed there fails at start when missing, so the file is a complete
   * account of what the app needs rather than a mix of requirements and
   * suggestions. A variable that is listed but optional makes the reader guess
   * which of the others are real.
   */
  describe('requireAuthUrl', () => {
    it.each([
      ['unset', undefined],
      ['the empty string', ''],
      ['only whitespace', '   '],
    ])('throws when BETTER_AUTH_URL is %s', (_label, value) => {
      if (value === undefined) {
        delete process.env.BETTER_AUTH_URL;
      } else {
        process.env.BETTER_AUTH_URL = value;
      }

      expect(() => requireAuthUrl()).toThrow(/BETTER_AUTH_URL/);
    });

    it('names the variable and says it is not derived from the request', () => {
      delete process.env.BETTER_AUTH_URL;

      expect(() => requireAuthUrl()).toThrow(/BETTER_AUTH_URL/);
      expect(() => requireAuthUrl()).toThrow(/unset or empty/i);
      expect(() => requireAuthUrl()).toThrow(/not derived\s+from the request/i);
    });

    it('returns the value when it is set', () => {
      process.env.BETTER_AUTH_URL = 'https://workspace.example.invalid';

      expect(requireAuthUrl()).toBe('https://workspace.example.invalid');
    });

    it('trims surrounding whitespace', () => {
      process.env.BETTER_AUTH_URL = '  http://localhost:3000  ';

      expect(requireAuthUrl()).toBe('http://localhost:3000');
    });

    /**
     * No fallback of any kind. A default of `http://localhost:3000` would be the
     * tempting shape and the dangerous one: it would work everywhere in
     * development and mint cookies for the wrong origin in production, which is
     * the failure that does not show up until it is live.
     */
    it('never falls back to a default origin', () => {
      delete process.env.BETTER_AUTH_URL;

      expect(() => requireAuthUrl()).toThrow();
    });
  });

  describe('requirePipecatApiKey', () => {
    it.each([
      ['unset', undefined],
      ['the empty string', ''],
      ['only whitespace', '   '],
    ])('throws when PIPECAT_API_KEY is %s', (_label, value) => {
      if (value === undefined) {
        delete process.env.PIPECAT_API_KEY;
      } else {
        process.env.PIPECAT_API_KEY = value;
      }

      expect(() => requirePipecatApiKey()).toThrow(/PIPECAT_API_KEY/);
    });

    it('returns a configured key without exposing it elsewhere', () => {
      process.env.PIPECAT_API_KEY = 'synthetic-pipecat-key-for-env-test';

      expect(requirePipecatApiKey()).toBe('synthetic-pipecat-key-for-env-test');
    });
  });

  /**
   * Reading at call time rather than module import is what lets `next build`
   * run with no database and no secrets. If these were read at import, the
   * production image build would need all three, and every deploy would depend
   * on the database being reachable from the builder.
   */
  it('reads the environment on every call, not once at import', () => {
    process.env.DATABASE_URL = 'postgres://first.invalid/db';
    expect(requireDatabaseUrl()).toBe('postgres://first.invalid/db');

    process.env.DATABASE_URL = 'postgres://second.invalid/db';
    expect(requireDatabaseUrl()).toBe('postgres://second.invalid/db');
  });

  /**
   * The same for all four, because importing this module is what `next build`
   * does. If any getter read its variable at import rather than at call time,
   * the production image build would need that variable — and `requireAuthUrl`
   * is the newest one, so it is the likeliest to acquire the habit.
   */
  it('lets every getter be imported with nothing set at all', () => {
    for (const name of VARIABLES) {
      delete process.env[name];
    }

    expect(() => requireDatabaseUrl()).toThrow(/DATABASE_URL/);
    expect(() => requireEncryptionKey()).toThrow(/ASSISTANT_SECRET_KEY/);
    expect(() => requireAuthSecret()).toThrow(/BETTER_AUTH_SECRET/);
    expect(() => requireAuthUrl()).toThrow(/BETTER_AUTH_URL/);
    expect(() => requirePipecatApiKey()).toThrow(/PIPECAT_API_KEY/);
  });

  /**
   * `.env.example` is the app's account of what it needs, and item 19 requires
   * it to be complete and to contain nothing else.
   *
   * **This was "exactly the guarded variables" and is now "guarded plus
   * declared-optional", which is a weakening, so it is worth saying what was
   * kept.** The original invariant's real value was that nothing could sit in
   * this file unvalidated — a variable the app reads but nothing checks is a
   * trap. `ALLOW_LOOPBACK_SERVER_URL` genuinely has no guard and should not
   * have one: a `require…()` guard exists to fail closed when *required*
   * config is missing, and an optional flag whose absence means "off" is
   * already closed.
   *
   * So the teeth move rather than come out. An optional variable has to earn
   * its place by being **absent-safe** — with it unset the application must
   * behave as the safe default — and that is asserted below rather than
   * asserted about. A new *required* variable still has to have a guard,
   * because it will not be in `OPTIONAL_VARIABLES` and the set comparison will
   * fail.
   */
  it('lists exactly the guarded and declared-optional variables in .env.example', () => {
    const example = readFileSync(
      fileURLToPath(new URL('../../../.env.example', import.meta.url)),
      'utf8',
    );

    const listed = [...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)]
      .map((match) => match[1] ?? '')
      .sort();

    expect(listed).toStrictEqual(
      [...VARIABLES, ...OPTIONAL_VARIABLES].sort(),
    );
  });
});

/**
 * The obligation that comes with being optional.
 *
 * A variable listed in `.env.example` without a guard is only acceptable while
 * its absence is the safe outcome. `ALLOW_LOOPBACK_SERVER_URL` unset must mean
 * loopback is **refused** — a default-on dev exception is a production hole
 * waiting for someone not to set the variable, which is exactly what this flag
 * was introduced to close.
 */
describe('declared-optional variables are absent-safe', () => {
  const savedFlag = process.env.ALLOW_LOOPBACK_SERVER_URL;

  afterEach(() => {
    if (savedFlag === undefined) {
      delete process.env.ALLOW_LOOPBACK_SERVER_URL;
    } else {
      process.env.ALLOW_LOOPBACK_SERVER_URL = savedFlag;
    }
  });

  it.each([
    ['unset', undefined],
    ['the empty string', ''],
  ])('refuses loopback when ALLOW_LOOPBACK_SERVER_URL is %s', (_label, value) => {
    if (value === undefined) {
      delete process.env.ALLOW_LOOPBACK_SERVER_URL;
    } else {
      process.env.ALLOW_LOOPBACK_SERVER_URL = value;
    }

    expect(
      validateServerUrl('http://localhost:3000/hook'),
      'loopback was accepted with the flag unset — the dev exception is on by default',
    ).not.toBeNull();
  });

  it('accepts loopback only when it is exactly "true"', () => {
    process.env.ALLOW_LOOPBACK_SERVER_URL = 'true';

    expect(validateServerUrl('http://localhost:3000/hook')).toBeNull();
  });

  /** Every optional variable is covered above; this fails if one is added. */
  it('has an absent-safe assertion for every declared-optional variable', () => {
    expect([...OPTIONAL_VARIABLES]).toStrictEqual(['ALLOW_LOOPBACK_SERVER_URL']);
  });
});
