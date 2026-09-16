import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONFORMANCE_SCENARIOS = [
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
] as const;

export type ConformanceScenarioName = (typeof CONFORMANCE_SCENARIOS)[number];

export interface ScenarioFixture {
  name: ConformanceScenarioName;
  request: string;
  expectation:
    'valid_stream' | 'problem' | 'same_commentary' | 'early_keepalive';
  status?: number;
  code?: string;
}

const packageRoot = resolve(
  fileURLToPath(new URL('../../..', import.meta.url)),
);

export async function loadScenario(
  name: ConformanceScenarioName,
): Promise<ScenarioFixture> {
  const path = resolve(packageRoot, 'fixtures/conformance', `${name}.json`);
  return JSON.parse(await readFile(path, 'utf8')) as ScenarioFixture;
}

export function fixturePath(...parts: string[]): string {
  return resolve(packageRoot, 'fixtures', ...parts);
}
