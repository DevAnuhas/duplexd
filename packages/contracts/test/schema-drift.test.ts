import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { distRoot, packageRoot, SCHEMA_FILES, schemaRoot } from './support/fixtures.js';

const repoRoot = resolve(packageRoot, '..', '..');
const buildScript = resolve(distRoot, 'scripts/build-schema.js');
const checkScript = resolve(distRoot, 'scripts/check-schema.js');

/** The complete expected output set: one file per export plus constants. */
const EXPECTED_FILES = [...Object.values(SCHEMA_FILES), 'constants.json'].sort();

function runCheck(): { status: number; output: string } {
  const result = spawnSync(process.execPath, [checkScript], { encoding: 'utf8' });
  return { status: result.status ?? -1, output: `${result.stdout}${result.stderr}` };
}

function generateInto(directory: string): void {
  const result = spawnSync(process.execPath, [buildScript, '--out-dir', directory], {
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(result.stderr || 'schema generation failed');
}

function snapshotCommitted(): Map<string, Buffer> {
  const snapshot = new Map<string, Buffer>();
  for (const file of readdirSync(schemaRoot)) {
    snapshot.set(file, readFileSync(resolve(schemaRoot, file)));
  }
  return snapshot;
}

/** Put the committed tree back byte-for-byte, whatever a test did to it. */
function restoreCommitted(snapshot: Map<string, Buffer>): void {
  for (const file of readdirSync(schemaRoot)) {
    if (!snapshot.has(file)) rmSync(resolve(schemaRoot, file));
  }
  for (const [file, bytes] of snapshot) {
    writeFileSync(resolve(schemaRoot, file), bytes);
  }
}

function withMutation(mutate: () => void, assertion: () => void): void {
  const snapshot = snapshotCommitted();
  try {
    mutate();
    assertion();
  } finally {
    restoreCommitted(snapshot);
  }
  // Restoration itself is load-bearing: a test that leaves the tree dirty
  // would make every later drift assertion meaningless.
  expect(runCheck().status, 'the committed tree was not restored byte-exactly').toBe(0);
}

describe('committed schema output', () => {
  it('is exactly the expected file set', () => {
    expect(readdirSync(schemaRoot).sort()).toEqual(EXPECTED_FILES);
  });

  it('passes the real drift verifier', () => {
    const { status, output } = runCheck();
    expect(output).not.toContain('differs');
    expect(status).toBe(0);
  });

  it('is byte-identical when generated twice into separate directories', () => {
    const first = mkdtempSync(resolve(tmpdir(), 'duplexd-schema-a-'));
    const second = mkdtempSync(resolve(tmpdir(), 'duplexd-schema-b-'));
    try {
      generateInto(first);
      generateInto(second);
      expect(readdirSync(first).sort()).toEqual(EXPECTED_FILES);
      expect(readdirSync(second).sort()).toEqual(EXPECTED_FILES);
      for (const file of EXPECTED_FILES) {
        expect(readFileSync(resolve(first, file)).equals(readFileSync(resolve(second, file))))
          .toBe(true);
      }
    } finally {
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });

  it('matches what real generation produces, byte for byte', () => {
    const temporary = mkdtempSync(resolve(tmpdir(), 'duplexd-schema-c-'));
    try {
      generateInto(temporary);
      for (const file of EXPECTED_FILES) {
        expect(
          readFileSync(resolve(temporary, file)).equals(readFileSync(resolve(schemaRoot, file))),
          `${file} differs from freshly generated output`,
        ).toBe(true);
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});

describe('the drift verifier rejects', () => {
  it('a changed committed schema', () => {
    withMutation(
      () => {
        const target = resolve(schemaRoot, 'CoreEvent.json');
        const schema = JSON.parse(readFileSync(target, 'utf8')) as Record<string, unknown>;
        schema.title = 'hand-edited';
        writeFileSync(target, `${JSON.stringify(schema, null, 2)}\n`);
      },
      () => {
        const { status, output } = runCheck();
        expect(status).not.toBe(0);
        expect(output).toContain('CoreEvent.json');
      },
    );
  });

  it('a changed committed constants.json', () => {
    withMutation(
      () => {
        const target = resolve(schemaRoot, 'constants.json');
        const constants = JSON.parse(readFileSync(target, 'utf8')) as Record<string, unknown>;
        constants.MAX_NDJSON_LINE_BYTES = 1;
        writeFileSync(target, `${JSON.stringify(constants, null, 2)}\n`);
      },
      () => {
        const { status, output } = runCheck();
        expect(status).not.toBe(0);
        expect(output).toContain('constants.json');
      },
    );
  });

  it('a whitespace-only change that leaves the JSON equal', () => {
    withMutation(
      () => {
        const target = resolve(schemaRoot, 'HandlerResult.json');
        writeFileSync(target, `${readFileSync(target, 'utf8')}\n`);
      },
      () => {
        expect(runCheck().status).not.toBe(0);
      },
    );
  });

  it('an extra or obsolete committed file', () => {
    withMutation(
      () => writeFileSync(resolve(schemaRoot, 'Obsolete.json'), '{}\n'),
      () => {
        const { status, output } = runCheck();
        expect(status).not.toBe(0);
        expect(output).toContain('file set differs');
      },
    );
  });

  it('a missing committed file', () => {
    withMutation(
      () => rmSync(resolve(schemaRoot, 'CallRecord.json')),
      () => {
        const { status, output } = runCheck();
        expect(status).not.toBe(0);
        expect(output).toContain('file set differs');
      },
    );
  });
});

describe('the CI drift gate', () => {
  const packageManifest = JSON.parse(
    readFileSync(resolve(packageRoot, 'package.json'), 'utf8'),
  ) as { scripts: Record<string, string> };
  const workflow = readFileSync(resolve(repoRoot, '.github/workflows/ci.yml'), 'utf8');

  it('runs real generation rather than reading a cache', () => {
    // `schema:check` shells straight to the built verifier: no turbo task, so
    // no cache can stand in for actually regenerating the artifacts.
    expect(packageManifest.scripts['schema:check']).toBe('node dist/scripts/check-schema.js');
    expect(packageManifest.scripts.build).toContain('node dist/scripts/build-schema.js');
    expect(workflow).toContain('pnpm --filter @duplexd/contracts schema:check');
  });

  it('also fails on a worktree diff and on untracked output', () => {
    expect(workflow).toContain('git diff --exit-code -- packages/contracts/schema');
    expect(workflow).toContain(
      "git ls-files --others --exclude-standard -- packages/contracts/schema",
    );
  });

  it('leaves the schema directory clean after generation', () => {
    const temporary = mkdtempSync(resolve(tmpdir(), 'duplexd-schema-d-'));
    try {
      generateInto(temporary);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
    const diff = execFileSync('git', ['status', '--porcelain', '--', 'packages/contracts/schema'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    const tracked = execFileSync('git', ['ls-files', '--', 'packages/contracts/schema'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean);

    // Before the first commit of this ticket the whole directory is new, so
    // "untracked" is expected. Once any of it is tracked, every file in it must
    // be — that is the state CI verifies on a pushed head.
    if (tracked.length > 0) {
      expect(diff, 'generation left the committed schema directory dirty').toBe('');
    } else {
      expect(diff.split('\n').filter(Boolean).every((line) => line.startsWith('??'))).toBe(true);
    }
  });
});
