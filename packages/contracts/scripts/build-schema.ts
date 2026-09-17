import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import {
  APPEND_TOKEN_BUDGET,
  CallRecord,
  CONTRACT_VERSION,
  CoreEvent,
  DEFAULT_HANDLER_TIMEOUT_MS,
  HANDLER_URL_PATTERN,
  HandlerRequestLoose,
  HandlerRequestStrict,
  HandlerResult,
  MAX_CONTENT_CHARS,
  MAX_HANDLER_TIMEOUT_MS,
  MAX_NDJSON_LINE_BYTES,
  MIN_HANDLER_TIMEOUT_MS,
  SCHEMA_DRAFT,
  SessionConfig,
  SessionCreateRequest,
  SIGNATURE_TOLERANCE_SECONDS,
} from '../src/index.js';

const packageRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const argument = process.argv.indexOf('--out-dir');
const requestedOutput = argument >= 0 ? process.argv[argument + 1] : undefined;
const outputDirectory =
  requestedOutput === undefined
    ? resolve(packageRoot, 'schema')
    : resolve(requestedOutput);
const portableHandlerUrlPattern = HANDLER_URL_PATTERN.source.replaceAll(
  '\\/',
  '/',
);

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => [key, sortValue(child)]),
    );
  }
  return value;
}

function stripRuntimeMetadata(value: unknown): unknown {
  if (value === HANDLER_URL_PATTERN.source) return portableHandlerUrlPattern;
  if (Array.isArray(value)) return value.map(stripRuntimeMetadata);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).filter(
      ([key, child]) => !(key === 'secret' && child === true),
    );
    return Object.fromEntries(
      entries.map(([key, child]) => [key, stripRuntimeMetadata(child)]),
    );
  }
  return value;
}

function schemaFor(name: string, schema: z.ZodType): object {
  const generated = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io: 'input',
  }) as Record<string, unknown>;
  return sortValue(
    stripRuntimeMetadata({
      ...generated,
      $id: `https://duplexd.dev/schema/v1/${name}.json`,
      $schema: SCHEMA_DRAFT,
    }),
  ) as object;
}

const schemas = {
  'CallRecord.json': schemaFor('CallRecord', CallRecord),
  'CoreEvent.json': schemaFor('CoreEvent', CoreEvent),
  'HandlerRequest.loose.json': schemaFor(
    'HandlerRequest.loose',
    HandlerRequestLoose,
  ),
  'HandlerRequest.strict.json': schemaFor(
    'HandlerRequest.strict',
    HandlerRequestStrict,
  ),
  'HandlerResult.json': schemaFor('HandlerResult', HandlerResult),
  'SessionConfig.json': schemaFor('SessionConfig', SessionConfig),
  'SessionCreateRequest.json': schemaFor(
    'SessionCreateRequest',
    SessionCreateRequest,
  ),
  'constants.json': sortValue({
    APPEND_TOKEN_BUDGET,
    CONTRACT_VERSION,
    DEFAULT_HANDLER_TIMEOUT_MS,
    HANDLER_URL_PATTERN: portableHandlerUrlPattern,
    MAX_CONTENT_CHARS,
    MAX_HANDLER_TIMEOUT_MS,
    MAX_NDJSON_LINE_BYTES,
    MIN_HANDLER_TIMEOUT_MS,
    SCHEMA_DRAFT,
    SIGNATURE_TOLERANCE_SECONDS,
  }),
};

await mkdir(outputDirectory, { recursive: true });
for (const entry of await readdir(outputDirectory)) {
  if (entry.endsWith('.json') && !(entry in schemas)) {
    await rm(resolve(outputDirectory, entry));
  }
}
for (const [name, schema] of Object.entries(schemas)) {
  await writeFile(
    resolve(outputDirectory, name),
    `${JSON.stringify(schema, null, 2)}\n`,
  );
}
