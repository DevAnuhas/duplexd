#!/usr/bin/env node

import {
  CONFORMANCE_SCENARIOS,
  type ConformanceScenarioName,
} from './scenarios.js';
import { runConformance } from './runner.js';

function valueAfter(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const url = valueAfter('--url');
const secret = valueAfter('--secret');
const scenario = valueAfter('--scenario');

if (url === undefined || secret === undefined) {
  console.error(
    'Usage: duplexd-conformance --url <handler-url> --secret <secret> [--scenario name]',
  );
  process.exitCode = 1;
} else if (
  scenario !== undefined &&
  !CONFORMANCE_SCENARIOS.includes(scenario as ConformanceScenarioName)
) {
  console.error(`Unknown conformance scenario: ${scenario}`);
  process.exitCode = 1;
} else {
  const report = await runConformance({
    url,
    secret,
    scenarios:
      scenario === undefined
        ? undefined
        : [scenario as ConformanceScenarioName],
  });
  for (const result of report.scenarios) {
    console.log(
      `${result.passed ? 'PASS' : 'FAIL'} ${result.name}${result.reason ? `: ${result.reason}` : ''}`,
    );
  }
  process.exitCode = report.passed ? 0 : 1;
}
