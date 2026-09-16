import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';

export const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
export const fixturesRoot = resolve(packageRoot, 'fixtures');
export const schemaRoot = resolve(packageRoot, 'schema');
export const distRoot = resolve(packageRoot, 'dist');

export function fixturePath(...parts: string[]): string {
  return resolve(fixturesRoot, ...parts);
}

export function readFixtureText(...parts: string[]): string {
  return readFileSync(fixturePath(...parts), 'utf8');
}

export function readFixtureBytes(...parts: string[]): Uint8Array {
  return new Uint8Array(readFileSync(fixturePath(...parts)));
}

export function readFixtureJson<T>(...parts: string[]): T {
  return JSON.parse(readFixtureText(...parts)) as T;
}

export function listFixtures(directory: string): string[] {
  return readdirSync(fixturePath(directory)).sort();
}

export function readCommittedSchema(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(schemaRoot, name), 'utf8')) as Record<
    string,
    unknown
  >;
}

/**
 * The schema names the equivalence suite knows about: each one is both a Zod
 * export from the package root and a committed `schema/<file>` artifact.
 */
export const SCHEMA_FILES = {
  SessionConfig: 'SessionConfig.json',
  SessionCreateRequest: 'SessionCreateRequest.json',
  CoreEvent: 'CoreEvent.json',
  HandlerRequestStrict: 'HandlerRequest.strict.json',
  HandlerRequestLoose: 'HandlerRequest.loose.json',
  HandlerResult: 'HandlerResult.json',
  CallRecord: 'CallRecord.json',
} as const;

export type SchemaName = keyof typeof SCHEMA_FILES;

/**
 * Ajv's draft-2020-12 implementation in strict validation mode.
 *
 * Strict mode stays on, and no custom keyword is registered: the build strips
 * the Zod-side `secret: true` redaction marker from the emitted schema, so the
 * committed artifacts are plain draft 2020-12 with nothing vendor-specific for
 * a non-TypeScript consumer to choke on. `schema-equivalence.test.ts` asserts
 * that independently, so a marker leaking back in fails loudly rather than
 * being papered over here.
 */
export function strictAjv(): Ajv2020 {
  return new Ajv2020({ strict: true, allErrors: true });
}

export function compileCommitted(name: SchemaName): ValidateFunction {
  return strictAjv().compile(readCommittedSchema(SCHEMA_FILES[name]));
}

export interface SchemaCase {
  name: string;
  schema: SchemaName;
  value: unknown;
  expected: 'valid' | 'invalid';
  /** `false` marks the one documented Zod-only bound; `reason` says why. */
  crossValidator?: boolean;
  reason?: string;
}

/** Every non-request schema case file, as `<file> -> cases`. */
export function loadSchemaCases(): Map<string, SchemaCase[]> {
  const entries = new Map<string, SchemaCase[]>();
  for (const file of listFixtures('schemas')) {
    if (file === 'session-config.json') continue;
    entries.set(file, readFixtureJson<{ cases: SchemaCase[] }>('schemas', file).cases);
  }
  return entries;
}

export interface RequestFixture {
  expected: { strict: 'valid' | 'invalid'; loose: 'valid' | 'invalid' };
  request: Record<string, unknown>;
}

export function loadRequestFixtures(): Map<string, RequestFixture> {
  const entries = new Map<string, RequestFixture>();
  for (const file of listFixtures('requests')) {
    entries.set(file.replace(/\.json$/, ''), readFixtureJson<RequestFixture>('requests', file));
  }
  return entries;
}

export interface ResultIndexEntry {
  schema: 'HandlerResult' | 'CoreEvent';
  expectItems: number;
  expectOutcome: 'done' | 'error';
  expectFinalDone?: boolean;
  expectError?: string;
  splitAt?: number[];
}

export function loadResultIndex(): Record<string, ResultIndexEntry> {
  return readFixtureJson<Record<string, ResultIndexEntry>>('results', 'index.json');
}

export interface MetadataFixture {
  rawHeaders: Array<[string, string]>;
  body: Record<string, unknown> & { contractVersion: string; sessionId: string };
  expected: {
    helper: { ok?: true; status?: number; code?: string };
    handler?: { status: number; code?: string; helperCalled?: boolean };
  };
}

export function loadMetadataFixtures(): Map<string, MetadataFixture> {
  const entries = new Map<string, MetadataFixture>();
  for (const file of listFixtures('metadata')) {
    entries.set(file.replace(/\.json$/, ''), readFixtureJson<MetadataFixture>('metadata', file));
  }
  return entries;
}

export interface SigningFixture {
  vectors: Array<{ secret: string; timestamp: number; body: string; header: string }>;
  tampered: Array<{ base: number; mutate: string; expectCode: string }>;
}

export function loadSigningFixture(): SigningFixture {
  return readFixtureJson<SigningFixture>('signing.json');
}

/**
 * The only secret-shaped values any fixture is allowed to carry. Everything
 * here is synthetic and inventoried; `fixture-inventory.test.ts` proves no
 * other credential-looking string reaches the fixture tree.
 */
export const SYNTHETIC_SECRETS = [
  /** The one secret every signing, metadata and conformance fixture shares. */
  'synthetic-test-secret',
  /** Exactly the sixteen-character minimum the remote auth schema allows. */
  'synthetic-16char',
  /** One character short of that minimum, so the bound has a failing case. */
  'synthetic-15cha',
] as const;
export const SYNTHETIC_TEST_SECRET = SYNTHETIC_SECRETS[0];
