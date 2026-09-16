import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

export const classifierPath = resolve(
  repoRoot,
  'scripts/classify-docs-only.sh',
);

export const ZERO_SHA = '0000000000000000000000000000000000000000';

/**
 * Git environment that makes fixture repositories reproducible regardless of
 * the developer's or CI runner's own Git configuration: no global/system
 * config, no signing, fixed identity and fixed timestamps.
 */
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z',
} satisfies NodeJS.ProcessEnv;

export interface ClassifierResult {
  stdout: string;
  stderr: string;
  status: number;
}

/**
 * Invokes the classifier exactly as the workflow does — as an executable with
 * positional arguments — and reports both its stdout and its exit status, so
 * tests can assert that ambiguous input resolves to `false` *without* the
 * step failing.
 */
export function classifyIn(cwd: string, ...args: string[]): ClassifierResult {
  const result = spawnSync(classifierPath, args, {
    cwd,
    env: gitEnv,
    encoding: 'utf8',
  });

  if (result.error) {
    throw result.error;
  }

  return {
    stdout: result.stdout.trim(),
    stderr: result.stderr,
    status: result.status ?? -1,
  };
}

/** Creates an empty directory that is deliberately not a Git repository. */
export function createNonRepoDir(): { dir: string; cleanup: () => void } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'duplexd-non-repo-')));

  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export class GitFixture {
  readonly dir: string;

  constructor() {
    // realpath matters on macOS, where os.tmpdir() is a symlink into /private.
    this.dir = realpathSync(mkdtempSync(join(tmpdir(), 'duplexd-classifier-')));
    this.git('init', '--quiet', '--initial-branch=main');
  }

  /** Runs a git command in the fixture, throwing on failure. */
  git(...args: string[]): string {
    const result = spawnSync('git', args, {
      cwd: this.dir,
      env: gitEnv,
      encoding: 'utf8',
    });

    if (result.status !== 0) {
      throw new Error(
        `git ${args.join(' ')} failed (${String(result.status)}): ${result.stderr}`,
      );
    }

    return result.stdout.trim();
  }

  /** Writes the given files and commits them, returning the new commit SHA. */
  commit(files: Record<string, string>, message: string): string {
    for (const [relativePath, contents] of Object.entries(files)) {
      const absolutePath = join(this.dir, relativePath);
      mkdirSync(dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, contents);
    }

    this.git('add', '--all');
    this.git('commit', '--quiet', '--message', message);

    return this.git('rev-parse', 'HEAD');
  }

  /** Creates an empty commit, returning the new commit SHA. */
  emptyCommit(message: string): string {
    this.git('commit', '--quiet', '--allow-empty', '--message', message);

    return this.git('rev-parse', 'HEAD');
  }

  rev(ref: string): string {
    return this.git('rev-parse', ref);
  }

  /** Invokes the classifier with this fixture as the working directory. */
  classify(...args: string[]): ClassifierResult {
    return classifyIn(this.dir, ...args);
  }

  cleanup(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}
