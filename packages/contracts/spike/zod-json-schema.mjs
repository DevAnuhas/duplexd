/* global URL, process */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';

import { z } from 'zod';

const HANDLER_URL_PATTERN =
  /^(?:https:\/\/(?:\[[0-9a-fA-F:]+\]|[^\s@/?#:[\]]+)(?::[0-9]+)?(?:[/?][^\s#]*)?|http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?(?:[/?][^\s#]*)?)$/;

const JsonValue = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(JsonValue),
    z.record(z.string(), JsonValue),
  ]),
);

const eventBase = {
  sessionId: z.string(),
  seq: z.number().int().min(1),
  at: z.string(),
};
const CoreEvent = z.discriminatedUnion('type', [
  z.strictObject({
    ...eventBase,
    type: z.literal('session.started'),
    payload: z.strictObject({}),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal('session.failed'),
    payload: z.strictObject({ reason: z.string() }),
  }),
]);

const NestedStrict = z.strictObject({
  nested: z.strictObject({ value: z.string() }),
});
const NestedLoose = z.looseObject({
  nested: z.looseObject({ value: z.string() }),
});
const PatternAndMax = z.string().regex(HANDLER_URL_PATTERN).max(500);

const schemas = {
  jsonValue: z.toJSONSchema(JsonValue, { target: 'draft-2020-12' }),
  coreEvent: z.toJSONSchema(CoreEvent, { target: 'draft-2020-12' }),
  nestedStrict: z.toJSONSchema(NestedStrict, { target: 'draft-2020-12' }),
  nestedLoose: z.toJSONSchema(NestedLoose, { target: 'draft-2020-12' }),
  patternAndMax: z.toJSONSchema(PatternAndMax, { target: 'draft-2020-12' }),
};

assert.equal(
  schemas.jsonValue.$schema,
  'https://json-schema.org/draft/2020-12/schema',
);
assert.match(JSON.stringify(schemas.jsonValue), /\$ref/);
assert.equal(schemas.coreEvent.oneOf?.length, 2);
assert.deepEqual(
  schemas.coreEvent.oneOf?.map((variant) => variant.properties.type.const),
  ['session.started', 'session.failed'],
);
assert.equal(schemas.nestedStrict.additionalProperties, false);
assert.equal(
  schemas.nestedStrict.properties.nested.additionalProperties,
  false,
);
assert.notEqual(schemas.nestedLoose.additionalProperties, false);
assert.notEqual(
  schemas.nestedLoose.properties.nested.additionalProperties,
  false,
);
assert.equal(schemas.patternAndMax.pattern, HANDLER_URL_PATTERN.source);
assert.equal(schemas.patternAndMax.maxLength, 500);

const captured = JSON.parse(
  await readFile(
    new URL('./zod-json-schema-output.json', import.meta.url),
    'utf8',
  ),
);
assert.deepEqual(captured, schemas);

process.stdout.write(`${JSON.stringify(schemas, null, 2)}\n`);
