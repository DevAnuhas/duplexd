import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const committedDirectory = resolve(packageRoot, 'schema');
const temporaryDirectory = await mkdtemp(resolve(tmpdir(), 'duplexd-schema-'));

try {
  const generation = spawnSync(
    process.execPath,
    [
      resolve(packageRoot, 'dist/scripts/build-schema.js'),
      '--out-dir',
      temporaryDirectory,
    ],
    { encoding: 'utf8' },
  );
  if (generation.status !== 0) {
    throw new Error(
      generation.stderr || generation.stdout || 'Schema generation failed',
    );
  }

  const expected = (await readdir(committedDirectory)).filter((name) =>
    name.endsWith('.json'),
  );
  const actual = (await readdir(temporaryDirectory)).filter((name) =>
    name.endsWith('.json'),
  );
  expected.sort();
  actual.sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Generated schema file set differs. committed=${expected.join(',')} generated=${actual.join(',')}`,
    );
  }

  for (const name of expected) {
    const committed = await readFile(resolve(committedDirectory, name));
    const generated = await readFile(resolve(temporaryDirectory, name));
    if (!committed.equals(generated)) {
      throw new Error(
        `Generated schema differs from committed packages/contracts/schema/${name}`,
      );
    }
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
