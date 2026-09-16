import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as contracts from '@duplexd/contracts';
import * as conformance from '@duplexd/contracts/conformance';

import { distRoot, packageRoot } from './support/fixtures.js';

const require = createRequire(import.meta.url);
const repoRoot = resolve(packageRoot, '..', '..');
const browserProof = fileURLToPath(new URL('./support/browser-proof.mjs', import.meta.url));

const manifest = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
  private: boolean;
  type: string;
  sideEffects: boolean;
  files: string[];
  exports: Record<string, { types: string; default: string }>;
  bin: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

describe('the package manifest', () => {
  it('is a private ESM-only workspace package at version 0.0.0', () => {
    expect(manifest.name).toBe('@duplexd/contracts');
    expect(manifest.version).toBe('0.0.0');
    expect(manifest.private).toBe(true);
    expect(manifest.type).toBe('module');
    expect(manifest.sideEffects).toBe(false);
    expect(manifest.exports['.']).not.toHaveProperty('require');
    expect(manifest.exports['./conformance']).not.toHaveProperty('require');
  });

  it('publishes built output plus the portable artifacts and nothing else', () => {
    expect([...manifest.files].sort()).toEqual(['dist', 'fixtures', 'schema']);
    for (const entry of manifest.files) {
      expect(statSync(resolve(packageRoot, entry)).isDirectory()).toBe(true);
    }
  });

  it('maps both entry points and the bin to built files', () => {
    expect(manifest.exports['.']?.default).toBe('./dist/src/index.js');
    expect(manifest.exports['./conformance']?.default).toBe('./dist/src/conformance/index.js');
    expect(manifest.bin['duplexd-conformance']).toBe('./dist/src/conformance/cli.js');
    for (const target of [
      manifest.exports['.']?.default,
      manifest.exports['.']?.types,
      manifest.exports['./conformance']?.default,
      manifest.exports['./conformance']?.types,
      manifest.bin['duplexd-conformance'],
    ]) {
      expect(() => statSync(resolve(packageRoot, target ?? '')), target).not.toThrow();
    }
  });

  it('resolves both entry points through the exports map', () => {
    expect(require.resolve('@duplexd/contracts')).toBe(resolve(distRoot, 'src/index.js'));
    expect(require.resolve('@duplexd/contracts/conformance')).toBe(
      resolve(distRoot, 'src/conformance/index.js'),
    );
  });

  it('depends on zod at runtime and on nothing first-party', () => {
    expect(manifest.dependencies).toEqual({ zod: expect.stringMatching(/^\d+\.\d+\.\d+$/) });
    for (const name of Object.keys(manifest.dependencies)) {
      expect(name.startsWith('@duplexd/'), `${name} is a first-party runtime dependency`).toBe(
        false,
      );
    }
    for (const forbidden of ['@duplexd/core', '@duplexd/server', 'openai', 'ws', 'fastify']) {
      expect(manifest.dependencies).not.toHaveProperty(forbidden);
      expect(manifest.devDependencies).not.toHaveProperty(forbidden);
    }
  });

  it('keeps the JSON Schema validator a development-only dependency', () => {
    expect(manifest.devDependencies).toHaveProperty('ajv');
    expect(manifest.dependencies).not.toHaveProperty('ajv');
  });

  it('pins every dependency to an exact literal version', () => {
    for (const [name, range] of Object.entries({
      ...manifest.dependencies,
      ...manifest.devDependencies,
    })) {
      expect(range, `${name} is not an exact version`).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});

describe('the root export surface', () => {
  it('exposes every constant the spec names', () => {
    for (const name of [
      'CONTRACT_VERSION',
      'APPEND_TOKEN_BUDGET',
      'MAX_CONTENT_CHARS',
      'DEFAULT_HANDLER_TIMEOUT_MS',
      'MIN_HANDLER_TIMEOUT_MS',
      'MAX_HANDLER_TIMEOUT_MS',
      'SIGNATURE_TOLERANCE_SECONDS',
      'MAX_NDJSON_LINE_BYTES',
      'HANDLER_URL_PATTERN',
      'SCHEMA_DRAFT',
    ]) {
      expect(contracts, `missing constant ${name}`).toHaveProperty(name);
    }
  });

  it('exposes every schema and helper the spec names', () => {
    for (const name of [
      'JsonValueSchema',
      'AppendKindSchema',
      'IsoTimestampSchema',
      'UsageSchema',
      'TranscriptFragmentSchema',
      'SessionConfig',
      'SessionCreateRequest',
      'HandlerConfigSchema',
      'CoreEvent',
      'handlerRequestSchema',
      'HandlerRequestStrict',
      'HandlerRequestLoose',
      'HandlerResult',
      'CallRecord',
      'signHandlerRequest',
      'verifyHandlerSignature',
      'checkHandlerRequestMetadata',
      'parseNdjson',
      'writeNdjson',
      'NdjsonLineTooLong',
      'NdjsonMalformedLine',
    ]) {
      expect(contracts, `missing export ${name}`).toHaveProperty(name);
    }
  });

  it('leaks nothing Node-only into the root surface', () => {
    for (const name of [
      'runConformance',
      'startReferenceHandler',
      'startBufferingHandler',
      'CONFORMANCE_SCENARIOS',
      'loadScenario',
      'fixturePath',
    ]) {
      expect(contracts, `root export leaks ${name}`).not.toHaveProperty(name);
    }
  });
});

describe('the conformance export surface', () => {
  it('exposes the runner, the scenario data and both test handlers', () => {
    for (const name of [
      'runConformance',
      'CONFORMANCE_SCENARIOS',
      'loadScenario',
      'fixturePath',
      'startReferenceHandler',
      'startBufferingHandler',
    ]) {
      expect(conformance, `missing conformance export ${name}`).toHaveProperty(name);
    }
  });

  it('is reachable only through its own subpath', () => {
    expect(() => require.resolve('@duplexd/contracts/runner')).toThrow();
    expect(() => require.resolve('@duplexd/contracts/src/conformance/runner.js')).toThrow();
  });
});

describe('the isomorphic source boundary', () => {
  const runtimeFiles = (() => {
    const found: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const full = resolve(directory, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'conformance') continue;
          walk(full);
        } else if (entry.name.endsWith('.ts')) {
          found.push(full);
        }
      }
    };
    walk(resolve(packageRoot, 'src'));
    return found;
  })();

  it('covers every runtime source file outside conformance', () => {
    expect(runtimeFiles.length).toBeGreaterThanOrEqual(8);
    expect(runtimeFiles.map((file) => relative(packageRoot, file)).sort()).not.toContain(
      'src/conformance/runner.ts',
    );
  });

  /**
   * Drop comments and string/template literals before scanning for globals.
   * Without this the schema literal `'in-process'` reads as the Node `process`
   * global, and `ArrayBufferLike` reads as `Buffer`.
   */
  const strippedCode = (source: string): string =>
    source
      .replaceAll(/\/\*[\s\S]*?\*\//g, ' ')
      .replaceAll(/\/\/[^\n]*/g, ' ')
      .replaceAll(/'(?:[^'\\\n]|\\.)*'/g, "''")
      .replaceAll(/"(?:[^"\\\n]|\\.)*"/g, '""')
      .replaceAll(/`(?:[^`\\]|\\.)*`/g, '``');

  it.each(runtimeFiles.map((file) => [relative(packageRoot, file), file]))(
    '%s imports no Node builtin and relies on no Node-only global',
    (_label, file) => {
      const source = readFileSync(file, 'utf8');
      const code = strippedCode(source);
      expect(source).not.toMatch(/from\s+['"]node:/);
      expect(source).not.toMatch(/import\s+['"]node:/);
      expect(source).not.toMatch(/require\s*\(/);
      for (const bare of ['fs', 'path', 'url', 'http', 'crypto', 'buffer', 'os', 'child_process']) {
        expect(source, `${_label} imports the bare builtin ${bare}`).not.toMatch(
          new RegExp(`from\\s+['"]${bare}['"]`),
        );
      }
      // Whole-identifier matches only: `ArrayBufferLike` is a TypeScript type,
      // not the Node `Buffer` global, and a substring check would flag it.
      for (const global of ['Buffer', 'process', '__dirname', '__filename', 'setImmediate']) {
        expect(code, `${_label} uses the Node global ${global}`).not.toMatch(
          new RegExp(`(?<![A-Za-z0-9_$.])${global}(?![A-Za-z0-9_$])`),
        );
      }
    },
  );

  it('is enforced by ESLint, not only by this test', () => {
    const config = readFileSync(resolve(repoRoot, 'eslint.config.js'), 'utf8');
    expect(config).toContain("files: ['packages/contracts/src/**/*.ts']");
    expect(config).toContain("ignores: ['packages/contracts/src/conformance/**/*.ts']");
    expect(config).toContain('no-restricted-imports');
    expect(config).toContain('no-restricted-globals');
    expect(config).toContain("group: ['node:*']");
  });

  it('really fails lint when a Node import is added to runtime source', () => {
    // A rule nobody has watched fail is not a rule. This runs ESLint over a
    // violating snippet fed through stdin at a runtime-source path, so nothing
    // on disk is touched.
    const violation = "import { readFile } from 'node:fs';\nexport const x = readFile;\n";
    const result = spawnSync(
      resolve(repoRoot, 'node_modules/.bin/eslint'),
      ['--stdin', '--stdin-filename', 'packages/contracts/src/__lint_probe__.ts', '--format', 'json'],
      { cwd: repoRoot, input: violation, encoding: 'utf8' },
    );
    expect(result.stdout).toContain('no-restricted-imports');
    expect(result.status).not.toBe(0);
  });
});

describe('the built root entry runs in a browser-like environment', () => {
  const runProof = (entry: string): Record<string, unknown> => {
    const output = execFileSync(process.execPath, [browserProof, entry], {
      encoding: 'utf8',
      cwd: packageRoot,
    });
    return JSON.parse(output.trim().split('\n').at(-1) ?? '{}') as Record<string, unknown>;
  };

  it('imports and actually works with Node globals and builtin resolution removed', () => {
    const result = runProof(resolve(distRoot, 'src/index.js'));
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    // Nothing quietly survived the deletion.
    expect(result.removedGlobals).toEqual([]);
    // Schemas parse.
    expect(result.handlerTimeoutMs).toBe(30_000);
    expect(result.maxNdjsonLineBytes).toBe(65_536);
    // WebCrypto signing and verification both run.
    expect(result.signatureShape).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.tamperedCode).toBe('invalid_signature');
    // NDJSON parses, including a multibyte payload.
    expect(result.items).toEqual([{ kind: 'commentary', content: '€ ok' }, { kind: 'done' }]);
    expect(result.written).toBe('{"kind":"done"}\n');
    expect(result.metadataOk).toBe(true);
  });

  it('is a load-bearing guard: the conformance entry fails the same proof', () => {
    // If the harness could not detect a Node import, the test above would pass
    // for a root entry that had quietly grown one.
    const result = runProof(resolve(distRoot, 'src/conformance/index.js'));
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/Node builtin/);
  });
});

describe('the package test suite is a real gate', () => {
  it('does not pass when no test file is collected', () => {
    // If the whole suite were deleted, `vitest run` must fail rather than
    // reporting success, so the root aggregate gate cannot go green without it.
    const result = spawnSync(
      resolve(repoRoot, 'node_modules/.bin/vitest'),
      ['run', '__deliberately_absent__'],
      { cwd: packageRoot, encoding: 'utf8' },
    );
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/No test files found/i);
  }, 60_000);

  it('never sets passWithNoTests anywhere in the config chain', () => {
    for (const file of [
      resolve(repoRoot, 'vitest.shared.ts'),
      resolve(repoRoot, 'vitest.config.ts'),
      resolve(packageRoot, 'vitest.config.ts'),
    ]) {
      expect(readFileSync(file, 'utf8')).not.toContain('passWithNoTests');
    }
    expect(JSON.stringify(manifest)).not.toContain('passWithNoTests');
  });

  it('is wired into the root aggregate test task', () => {
    const rootManifest = JSON.parse(
      readFileSync(resolve(repoRoot, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    const turbo = JSON.parse(readFileSync(resolve(repoRoot, 'turbo.json'), 'utf8')) as {
      tasks: Record<string, { dependsOn?: string[] }>;
    };
    expect(rootManifest.scripts.test).toBe('turbo run test');
    // The package suite needs built output, so the task depends on a build.
    expect(turbo.tasks.test?.dependsOn).toContain('build');
    expect(turbo.tasks.test?.dependsOn).toContain('^build');
  });
});
