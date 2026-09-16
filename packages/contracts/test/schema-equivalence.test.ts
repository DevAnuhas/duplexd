import { describe, expect, it } from 'vitest';

import * as contracts from '@duplexd/contracts';
import type { ZodType } from 'zod';

import {
  compileCommitted,
  loadRequestFixtures,
  loadSchemaCases,
  readCommittedSchema,
  SCHEMA_FILES,
  type SchemaName,
} from './support/fixtures.js';

const zodFor: Record<SchemaName, ZodType> = {
  SessionConfig: contracts.SessionConfig,
  SessionCreateRequest: contracts.SessionCreateRequest,
  CoreEvent: contracts.CoreEvent,
  HandlerRequestStrict: contracts.HandlerRequestStrict,
  HandlerRequestLoose: contracts.HandlerRequestLoose,
  HandlerResult: contracts.HandlerResult,
  CallRecord: contracts.CallRecord,
};

const validators = Object.fromEntries(
  (Object.keys(SCHEMA_FILES) as SchemaName[]).map((name) => [name, compileCommitted(name)]),
) as Record<SchemaName, ReturnType<typeof compileCommitted>>;

/**
 * Keywords draft 2020-12 defines, plus the annotations Zod legitimately emits.
 * Anything outside this set in a committed artifact is a vendor extension that
 * another language's validator would either ignore or refuse — exactly what the
 * contract forbids.
 */
const ALLOWED_KEYWORDS = new Set([
  '$anchor',
  '$comment',
  '$defs',
  '$dynamicAnchor',
  '$dynamicRef',
  '$id',
  '$ref',
  '$schema',
  '$vocabulary',
  'additionalProperties',
  'allOf',
  'anyOf',
  'const',
  'contains',
  'default',
  'dependentRequired',
  'dependentSchemas',
  'deprecated',
  'description',
  'else',
  'enum',
  'examples',
  'exclusiveMaximum',
  'exclusiveMinimum',
  'format',
  'if',
  'items',
  'maxContains',
  'maxItems',
  'maxLength',
  'maxProperties',
  'maximum',
  'minContains',
  'minItems',
  'minLength',
  'minProperties',
  'minimum',
  'multipleOf',
  'not',
  'oneOf',
  'pattern',
  'patternProperties',
  'prefixItems',
  'properties',
  'propertyNames',
  'readOnly',
  'required',
  'then',
  'title',
  'type',
  'unevaluatedItems',
  'unevaluatedProperties',
  'uniqueItems',
  'writeOnly',
]);

/** Walk a schema, yielding `[jsonPointer, keyword]` for every keyword position. */
function* keywords(
  node: unknown,
  pointer = '',
  inSchema = true,
): Generator<[string, string]> {
  if (Array.isArray(node)) {
    for (const [index, child] of node.entries()) {
      yield* keywords(child, `${pointer}/${index}`, inSchema);
    }
    return;
  }
  if (node === null || typeof node !== 'object') return;
  for (const [key, child] of Object.entries(node)) {
    const childPointer = `${pointer}/${key}`;
    if (inSchema) yield [childPointer, key];
    // `properties`, `$defs` and `patternProperties` hold schemas keyed by an
    // arbitrary name, so the next level down is names, not keywords.
    const namesNext = inSchema && ['properties', '$defs', 'patternProperties'].includes(key);
    yield* keywords(child, childPointer, namesNext ? false : true);
  }
}

describe('committed JSON Schema artifacts', () => {
  it.each(Object.entries(SCHEMA_FILES))(
    '%s compiles under Ajv draft 2020-12 in strict mode',
    (_name, file) => {
      const schema = readCommittedSchema(file);
      expect(() => compileCommitted(_name as SchemaName)).not.toThrow();
      expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
      expect(schema.$id).toBe(
        `https://duplexd.dev/schema/v1/${file.replace(/\.json$/, '')}.json`,
      );
    },
  );

  it.each(Object.entries(SCHEMA_FILES))('%s emits no vendor keyword', (_name, file) => {
    const offenders = [...keywords(readCommittedSchema(file))]
      .filter(([, keyword]) => !ALLOWED_KEYWORDS.has(keyword))
      .map(([pointer, keyword]) => `${keyword} at ${pointer}`);
    expect(offenders, `${file} carries non-standard keywords`).toEqual([]);
  });

  it('keeps the Zod-side secret marker out of every portable artifact', () => {
    // The marker stays on the Zod schema for redaction code to find; the
    // exported artifact another language compiles must not carry it.
    for (const file of Object.values(SCHEMA_FILES)) {
      const text = JSON.stringify(readCommittedSchema(file));
      expect(text, `${file} leaks the secret marker`).not.toContain('"secret":true');
    }
  });

  it('exposes no secret value, only the shape of one', () => {
    for (const file of Object.values(SCHEMA_FILES)) {
      const text = JSON.stringify(readCommittedSchema(file));
      expect(text, `${file} leaks a fixture secret`).not.toContain('synthetic-test-secret');
    }
  });
});

describe('Zod and JSON Schema agree over every request fixture', () => {
  const requests = loadRequestFixtures();

  it.each([...requests])('%s under HandlerRequestStrict', (name, fixture) => {
    const expected = fixture.expected.strict === 'valid';
    expect(zodFor.HandlerRequestStrict.safeParse(fixture.request).success, `zod ${name}`).toBe(
      expected,
    );
    expect(validators.HandlerRequestStrict(fixture.request), `ajv ${name}`).toBe(expected);
  });

  it.each([...requests])('%s under HandlerRequestLoose', (name, fixture) => {
    const expected = fixture.expected.loose === 'valid';
    expect(zodFor.HandlerRequestLoose.safeParse(fixture.request).success, `zod ${name}`).toBe(
      expected,
    );
    expect(validators.HandlerRequestLoose(fixture.request), `ajv ${name}`).toBe(expected);
  });

  it('reads the expectation from the fixture rather than inferring it', () => {
    for (const [name, fixture] of requests) {
      expect(fixture.expected, `${name} has no expected block`).toBeDefined();
      expect(['valid', 'invalid']).toContain(fixture.expected.strict);
      expect(['valid', 'invalid']).toContain(fixture.expected.loose);
    }
  });
});

describe('Zod and JSON Schema agree over every non-request fixture', () => {
  const files = loadSchemaCases();
  const crossValidated = [...files].flatMap(([file, cases]) =>
    cases
      .filter((entry) => entry.crossValidator !== false)
      .map((entry) => [`${file}: ${entry.schema} ${entry.name}`, entry] as const),
  );

  it.each(crossValidated)('%s', (_label, entry) => {
    const expected = entry.expected === 'valid';
    expect(zodFor[entry.schema].safeParse(entry.value).success, 'zod').toBe(expected);
    expect(validators[entry.schema](entry.value), 'ajv').toBe(expected);
  });

  it('covers every exported schema with both a valid and an invalid case', () => {
    const covered = new Map<string, Set<string>>();
    for (const [, cases] of files) {
      for (const entry of cases) {
        const seen = covered.get(entry.schema) ?? new Set<string>();
        seen.add(entry.expected);
        covered.set(entry.schema, seen);
      }
    }
    for (const schema of ['SessionConfig', 'SessionCreateRequest', 'CoreEvent', 'HandlerResult', 'CallRecord']) {
      expect([...(covered.get(schema) ?? [])].sort(), `${schema} coverage`).toEqual([
        'invalid',
        'valid',
      ]);
    }
  });
});

describe('the one documented equivalence exception', () => {
  const excluded = [...loadSchemaCases()].flatMap(([, cases]) =>
    cases.filter((entry) => entry.crossValidator === false),
  );

  it('is limited to the consumerContext bound on SessionConfig and SessionCreateRequest', () => {
    expect(excluded.length).toBeGreaterThan(0);
    for (const entry of excluded) {
      expect(['SessionConfig', 'SessionCreateRequest']).toContain(entry.schema);
      expect(entry.name).toContain('consumerContext');
      expect(entry.reason).toBeTruthy();
    }
  });

  it('is a real divergence, not a hypothetical one', () => {
    // If the exported schema ever learns to express this bound, this test
    // fails and the exclusion should be deleted rather than kept out of habit.
    const overBound = excluded.find(
      (entry) => entry.schema === 'SessionConfig' && entry.expected === 'invalid',
    );
    expect(overBound).toBeDefined();
    if (overBound === undefined) return;
    expect(zodFor.SessionConfig.safeParse(overBound.value).success, 'zod should reject').toBe(false);
    expect(validators.SessionConfig(overBound.value), 'ajv cannot see the bound').toBe(true);
  });

  it('is the only divergence across the whole fixture corpus', () => {
    const divergent: string[] = [];
    for (const [file, cases] of loadSchemaCases()) {
      for (const entry of cases) {
        const zod = zodFor[entry.schema].safeParse(entry.value).success;
        const ajv = validators[entry.schema](entry.value) === true;
        if (zod !== ajv && entry.crossValidator !== false) {
          divergent.push(`${file}: ${entry.schema} ${entry.name}`);
        }
      }
    }
    expect(divergent).toEqual([]);
  });
});
