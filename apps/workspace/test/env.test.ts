import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  requireAuthSecret,
  requireAuthUrl,
  requireDatabaseUrl,
  requireEncryptionKey,
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
] as const;

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
  });

  /**
   * `.env.example` is the app's account of what it needs, and item 19 requires
   * it to be complete and to contain nothing else. This pins the two halves
   * together: every variable with a guard is listed, and the file lists no
   * variable that has no guard.
   */
  it('lists exactly the guarded variables in .env.example', () => {
    const example = readFileSync(
      fileURLToPath(new URL('../../../.env.example', import.meta.url)),
      'utf8',
    );

    const listed = [...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)]
      .map((match) => match[1] ?? '')
      .sort();

    expect(listed).toStrictEqual([...VARIABLES].sort());
  });
});
