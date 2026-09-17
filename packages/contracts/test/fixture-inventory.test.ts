import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  fixturesRoot,
  listFixtures,
  loadResultIndex,
  loadSigningFixture,
  packageRoot,
  readFixtureJson,
  schemaRoot,
  SYNTHETIC_SECRETS,
  SYNTHETIC_TEST_SECRET,
} from './support/fixtures.js';

const repoRoot = resolve(packageRoot, '..', '..');

/**
 * The mandatory fixture inventory. These assertions fail the moment a named
 * fixture disappears, which is what stops a suite from quietly shrinking to
 * whatever still happens to pass.
 */
const REQUIRED = {
  requests: [
    'booking',
    'order-status',
    'empty-transcript',
    'unknown-fields',
    'prior-delegations',
    'missing-field',
    'wrong-offset',
    'keepalive-delay',
  ],
  results: [
    'booking.ndjson',
    'keepalives.ndjson',
    'clean-end.ndjson',
    'order-status.ndjson',
    'unknown-kind.ndjson',
    'oversized.ndjson',
    'exact-max.ndjson',
    'line-too-long.ndjson',
    'oversized-whitespace.ndjson',
    'core-event.ndjson',
  ],
  metadata: [
    'valid',
    'session-changed',
    'session-missing',
    'session-duplicated',
    'version-changed',
    'version-missing',
    'version-duplicated',
    'body-session-changed',
    'unsupported-version',
    'case-insensitive-and-comma-id',
  ],
  conformance: [
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
  ],
  schemas: ['session-config', 'session', 'core-event', 'handler-result', 'call-record'],
} as const;

function walkFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = resolve(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else found.push(full);
    }
  };
  walk(root);
  return found;
}

describe('the fixture inventory', () => {
  it.each(Object.entries(REQUIRED))('%s carries every mandatory fixture', (directory, names) => {
    const present = listFixtures(directory);
    for (const name of names) {
      const file = name.endsWith('.ndjson') ? name : `${name}.json`;
      expect(present, `fixtures/${directory}/${file} is missing`).toContain(file);
    }
  });

  it('keeps the request fixtures the spec enumerates, with their split expectations', () => {
    const expectations = new Map(
      REQUIRED.requests.map((name) => [
        name,
        readFixtureJson<{ expected: { strict: string; loose: string } }>(
          'requests',
          `${name}.json`,
        ).expected,
      ]),
    );
    // The extra-field fixture is the strict/loose split; the broken ones fail
    // under both. Without this, "unknown-fields" could quietly become valid
    // under strict and the split would stop being tested.
    expect(expectations.get('unknown-fields')).toEqual({ strict: 'invalid', loose: 'valid' });
    expect(expectations.get('missing-field')).toEqual({ strict: 'invalid', loose: 'invalid' });
    expect(expectations.get('wrong-offset')).toEqual({ strict: 'invalid', loose: 'invalid' });
    expect(expectations.get('booking')).toEqual({ strict: 'valid', loose: 'valid' });
    expect(expectations.get('order-status')).toEqual({ strict: 'valid', loose: 'valid' });
  });

  it('contrasts the booking and order-status transcripts', () => {
    const transcriptOf = (name: string) =>
      readFixtureJson<{ request: { transcript: Array<{ text: string }> } }>(
        'requests',
        `${name}.json`,
      ).request.transcript;
    const booking = transcriptOf('booking');
    const orderStatus = transcriptOf('order-status');
    expect(booking.length).toBeGreaterThan(0);
    expect(orderStatus.length).toBeGreaterThan(0);
    expect(orderStatus).not.toEqual(booking);
  });

  it('declares an expectation for every result stream and no orphans', () => {
    const index = loadResultIndex();
    const files = listFixtures('results').filter((file) => file.endsWith('.ndjson'));
    expect(Object.keys(index).sort()).toEqual(files.sort());
    for (const [name, entry] of Object.entries(index)) {
      expect(['HandlerResult', 'CoreEvent'], `${name} schema`).toContain(entry.schema);
      expect(['done', 'error'], `${name} outcome`).toContain(entry.expectOutcome);
      expect(entry.expectItems, `${name} item count`).toBeTypeOf('number');
      if (entry.expectOutcome === 'error') expect(entry.expectError, `${name} error`).toBeTruthy();
    }
  });

  it('keeps the boundary streams on the right side of their bounds', () => {
    const size = (name: string) => statSync(resolve(fixturesRoot, 'results', name)).size;
    // Over both content limits but comfortably under the byte bound.
    expect(size('oversized.ndjson')).toBeLessThan(65_536);
    // Over the byte bound.
    expect(size('line-too-long.ndjson')).toBeGreaterThan(65_536);
    expect(size('oversized-whitespace.ndjson')).toBeGreaterThan(65_536);
    // Exactly at the content limit, so still a legal line.
    expect(size('exact-max.ndjson')).toBeLessThan(65_536);
  });

  it('gives every signing vector a tampered counterpart', () => {
    const signing = loadSigningFixture();
    expect(signing.vectors.length).toBeGreaterThan(0);
    expect(signing.tampered.length).toBeGreaterThanOrEqual(4);
    for (const entry of signing.tampered) {
      expect(signing.vectors[entry.base], `tampered base ${entry.base}`).toBeDefined();
      expect(entry.expectCode).toBe('invalid_signature');
    }
    for (const vector of signing.vectors) {
      expect(vector.header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
      expect(vector.timestamp).toBeTypeOf('number');
      expect(vector.body.length).toBeGreaterThan(0);
    }
  });
});

describe('fixture credential hygiene', () => {
  const fixtureFiles = walkFiles(fixturesRoot);

  it('uses only the inventoried synthetic secrets', () => {
    expect(SYNTHETIC_SECRETS).toEqual([
      'synthetic-test-secret',
      'synthetic-16char',
      'synthetic-15cha',
    ]);
    const offenders: string[] = [];
    for (const file of fixtureFiles) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/"secret"\s*:\s*"([^"]*)"/g)) {
        const value = match[1] ?? '';
        if (!SYNTHETIC_SECRETS.includes(value as (typeof SYNTHETIC_SECRETS)[number])) {
          offenders.push(`${relative(packageRoot, file)}: ${value.slice(0, 8)}…`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('carries nothing that looks like a real credential', () => {
    const patterns: Array<[string, RegExp]> = [
      ['OpenAI key', /\bsk-[A-Za-z0-9_-]{16,}/],
      ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
      ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{20,}/],
      ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
      ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
      ['bearer header', /Authorization"?\s*[:=]\s*"?Bearer\s+\S/i],
    ];
    for (const file of fixtureFiles) {
      const text = readFileSync(file, 'utf8');
      for (const [label, pattern] of patterns) {
        expect(pattern.test(text), `${relative(packageRoot, file)} contains a ${label}`).toBe(false);
      }
    }
  });

  it('keeps every secret out of the generated schema artifacts', () => {
    for (const file of readdirSync(schemaRoot)) {
      const text = readFileSync(resolve(schemaRoot, file), 'utf8');
      for (const secret of SYNTHETIC_SECRETS) {
        expect(text, `schema/${file} leaks ${secret}`).not.toContain(secret);
      }
    }
  });

  it('keeps consumer context and secrets out of the persisted-record fixtures', () => {
    const text = readFileSync(resolve(fixturesRoot, 'schemas/call-record.json'), 'utf8');
    // The one place either appears is the deliberately invalid case proving
    // the schema rejects it.
    const cases = readFixtureJson<{ cases: Array<{ expected: string; value: unknown }> }>(
      'schemas',
      'call-record.json',
    ).cases;
    for (const entry of cases) {
      if (entry.expected === 'valid') {
        const serialized = JSON.stringify(entry.value);
        expect(serialized).not.toContain('consumerContext');
        expect(serialized).not.toContain(SYNTHETIC_TEST_SECRET);
      }
    }
    expect(text).toContain(SYNTHETIC_TEST_SECRET);
  });

  it('commits no environment file anywhere in the repository', () => {
    for (const name of ['.env', '.env.local', '.env.production', 'packages/contracts/.env']) {
      expect(existsSync(resolve(repoRoot, name)), `${name} is present`).toBe(false);
    }
    // The documented placeholder template is the only env file that ships.
    expect(existsSync(resolve(repoRoot, '.env.example'))).toBe(true);
  });

});
