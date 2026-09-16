import { accessSync, constants } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  classifierPath,
  classifyIn,
  createNonRepoDir,
  GitFixture,
  ZERO_SHA,
  type ClassifierResult,
} from './helpers/git-fixture.ts';

let repo: GitFixture;
let initial: string;

/**
 * Every assertion goes through here on purpose. Contract 39a requires that
 * ambiguity and error resolve to `docs_only=false` *successfully* — a
 * classifier that exits nonzero would fail the `changes` job instead of
 * falling back to running the full `checks` job, which is the exact failure
 * mode this suite exists to prevent.
 */
function expectClassification(
  result: ClassifierResult,
  expected: 'true' | 'false',
): void {
  expect(result.status, `classifier exited nonzero: ${result.stderr}`).toBe(0);
  expect(result.stdout).toBe(expected);
}

/**
 * Applies one working-tree mutation as a single commit and classifies it the
 * way the workflow would for the given event, so a single table of expectations
 * can cover both the merge-base (`pull_request`) and `before..after` (`push`)
 * revision ranges.
 */
function classifyMutation(
  mode: 'pull_request' | 'push',
  mutate: () => void,
  message: string,
): ClassifierResult {
  if (mode === 'pull_request') {
    repo.git('checkout', '--quiet', '-b', 'feature');
    mutate();
    repo.commitAll(message);

    return repo.classify('pull_request', 'main', 'feature');
  }

  mutate();
  const after = repo.commitAll(message);

  return repo.classify('push', initial, after);
}

beforeEach(() => {
  repo = new GitFixture();
  initial = repo.commit(
    {
      'README.md': '# duplexd\n',
      'src/app.ts': 'export const app = 1;\n',
      'docs/index.md': '# docs\n',
    },
    'initial',
  );
});

afterEach(() => {
  repo.cleanup();
});

describe('classify-docs-only.sh', () => {
  it('is committed as an executable script', () => {
    expect(() => accessSync(classifierPath, constants.X_OK)).not.toThrow();
  });

  describe('pull_request events', () => {
    it('classifies a multi-commit docs-only PR as docs-only', () => {
      repo.git('checkout', '--quiet', '-b', 'feature');
      repo.commit({ 'docs/guide.md': '# guide\n' }, 'docs: add guide');
      repo.commit(
        { 'README.md': '# duplexd\n\nmore\n' },
        'docs: expand readme',
      );

      // The base branch moves ahead with a *code* change after the branch
      // point. Diffing `main..feature` would surface that file as a reversal
      // and misclassify; diffing the merge base must not.
      repo.git('checkout', '--quiet', 'main');
      repo.commit(
        { 'src/app.ts': 'export const app = 2;\n' },
        'feat: bump app',
      );

      expectClassification(
        repo.classify('pull_request', 'main', 'feature'),
        'true',
      );
    });

    it('classifies a mixed docs-and-code PR as not docs-only', () => {
      repo.git('checkout', '--quiet', '-b', 'feature');
      repo.commit({ 'src/api.ts': 'export const api = 1;\n' }, 'feat: add api');
      // The tip commit alone is docs-only, so a `HEAD^..HEAD` implementation
      // would wrongly report true here.
      repo.commit({ 'docs/api.md': '# api\n' }, 'docs: document api');

      expectClassification(
        repo.classify('pull_request', 'main', 'feature'),
        'false',
      );
    });

    it('classifies a PR that changed nothing as not docs-only', () => {
      repo.git('checkout', '--quiet', '-b', 'feature');
      repo.emptyCommit('chore: empty');

      expectClassification(
        repo.classify('pull_request', 'main', 'feature'),
        'false',
      );
    });

    it('treats non-markdown files under docs/ as documentation', () => {
      repo.git('checkout', '--quiet', '-b', 'feature');
      repo.commit(
        { 'docs/assets/diagram.svg': '<svg />\n' },
        'docs: add diagram',
      );

      expectClassification(
        repo.classify('pull_request', 'main', 'feature'),
        'true',
      );
    });

    it('treats markdown outside docs/ as documentation', () => {
      repo.git('checkout', '--quiet', '-b', 'feature');
      repo.commit(
        { 'packages/core/README.md': '# core\n' },
        'docs: package readme',
      );

      expectClassification(
        repo.classify('pull_request', 'main', 'feature'),
        'true',
      );
    });

    it('does not treat a docs-prefixed sibling directory as documentation', () => {
      repo.git('checkout', '--quiet', '-b', 'feature');
      repo.commit(
        { 'docsy/tool.ts': 'export const tool = 1;\n' },
        'feat: docsy tool',
      );

      expectClassification(
        repo.classify('pull_request', 'main', 'feature'),
        'false',
      );
    });

    it('classifies an unresolvable base ref as not docs-only', () => {
      repo.git('checkout', '--quiet', '-b', 'feature');
      repo.commit({ 'docs/guide.md': '# guide\n' }, 'docs: add guide');

      expectClassification(
        repo.classify('pull_request', 'refs/heads/does-not-exist', 'feature'),
        'false',
      );
    });

    it('classifies an unresolvable head ref as not docs-only', () => {
      expectClassification(
        repo.classify('pull_request', 'main', 'refs/heads/does-not-exist'),
        'false',
      );
    });

    it('classifies a missing base argument as not docs-only', () => {
      expectClassification(repo.classify('pull_request', '', 'main'), 'false');
    });

    it('classifies a missing head argument as not docs-only', () => {
      expectClassification(repo.classify('pull_request', 'main'), 'false');
    });
  });

  describe('push events', () => {
    it('classifies a normal docs-only push as docs-only', () => {
      const after = repo.commit(
        { 'docs/notes.md': '# notes\n' },
        'docs: add notes',
      );

      expectClassification(repo.classify('push', initial, after), 'true');
    });

    it('classifies a multi-commit mixed push as not docs-only', () => {
      repo.commit({ 'docs/notes.md': '# notes\n' }, 'docs: add notes');
      const after = repo.commit(
        { 'src/lib.ts': 'export const lib = 1;\n' },
        'feat: lib',
      );

      expectClassification(repo.classify('push', initial, after), 'false');
    });

    it('classifies a multi-commit docs-only push as docs-only', () => {
      repo.commit({ 'docs/notes.md': '# notes\n' }, 'docs: add notes');
      const after = repo.commit(
        { 'CHANGELOG.md': '# changelog\n' },
        'docs: changelog',
      );

      expectClassification(repo.classify('push', initial, after), 'true');
    });

    it('classifies an all-zero first-push base as not docs-only', () => {
      const after = repo.commit(
        { 'docs/notes.md': '# notes\n' },
        'docs: add notes',
      );

      expectClassification(repo.classify('push', ZERO_SHA, after), 'false');
    });

    it('classifies a non-ancestor force-push base as not docs-only', () => {
      // Both branches are docs-only, so only the ancestry check can catch
      // this. A naive `base..head` diff would report true.
      repo.git('checkout', '--quiet', '-b', 'forced-a');
      const tipA = repo.commit({ 'docs/a.md': '# a\n' }, 'docs: a');

      repo.git('checkout', '--quiet', '-b', 'forced-b', initial);
      const tipB = repo.commit({ 'docs/b.md': '# b\n' }, 'docs: b');

      expectClassification(repo.classify('push', tipA, tipB), 'false');
    });

    it('classifies an empty diff as not docs-only', () => {
      expectClassification(repo.classify('push', initial, initial), 'false');
    });

    it('classifies a push of only empty commits as not docs-only', () => {
      const after = repo.emptyCommit('chore: empty');

      expectClassification(repo.classify('push', initial, after), 'false');
    });

    it('classifies an unresolvable base SHA as not docs-only', () => {
      const after = repo.commit(
        { 'docs/notes.md': '# notes\n' },
        'docs: add notes',
      );

      expectClassification(
        repo.classify(
          'push',
          'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
          after,
        ),
        'false',
      );
    });

    it('classifies an unresolvable head SHA as not docs-only', () => {
      expectClassification(
        repo.classify(
          'push',
          initial,
          'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        ),
        'false',
      );
    });

    it('classifies a missing base argument as not docs-only', () => {
      expectClassification(repo.classify('push', '', initial), 'false');
    });

    it('classifies a missing head argument as not docs-only', () => {
      expectClassification(repo.classify('push', initial), 'false');
    });
  });

  /**
   * Deletions and renames are the cases a `--name-only --diff-filter=ACMRT`
   * classifier gets wrong in both directions: it drops deleted paths entirely
   * (so removing a source file looks like "nothing changed", and removing a
   * docs file looks the same) and it reports only a rename's destination (so
   * moving code *into* `docs/` looks like a documentation change).
   *
   * Both event modes are exercised from the same table because the two code
   * paths in the classifier compute their revision range differently and can
   * regress independently.
   */
  describe.each(['pull_request', 'push'] as const)(
    'deletions and renames (%s events)',
    (mode) => {
      it('classifies deleting a source file alongside a docs edit as not docs-only', () => {
        expectClassification(
          classifyMutation(
            mode,
            () => {
              repo.git('rm', '--quiet', 'src/app.ts');
              repo.write({ 'README.md': '# duplexd\n\nupdated\n' });
            },
            'chore: drop app and touch readme',
          ),
          'false',
        );
      });

      it('classifies deleting only a source file as not docs-only', () => {
        expectClassification(
          classifyMutation(
            mode,
            () => {
              repo.git('rm', '--quiet', 'src/app.ts');
            },
            'chore: drop app',
          ),
          'false',
        );
      });

      it('classifies deleting only a documentation file as docs-only', () => {
        expectClassification(
          classifyMutation(
            mode,
            () => {
              repo.git('rm', '--quiet', 'docs/index.md');
            },
            'docs: drop index',
          ),
          'true',
        );
      });

      it('classifies moving a source file into docs/ as not docs-only', () => {
        // Rename detection reports only `docs/app.ts` unless the source side
        // is considered too — the deleted `src/app.ts` is what makes this a
        // code change.
        expectClassification(
          classifyMutation(
            mode,
            () => {
              repo.git('mv', 'src/app.ts', 'docs/app.ts');
            },
            'chore: move app into docs',
          ),
          'false',
        );
      });

      it('classifies moving a documentation file out of docs/ into src/ as not docs-only', () => {
        expectClassification(
          classifyMutation(
            mode,
            () => {
              repo.git('mv', 'docs/index.md', 'src/index.ts');
            },
            'chore: move index into src',
          ),
          'false',
        );
      });

      it('preserves a docs-to-docs rename as docs-only', () => {
        expectClassification(
          classifyMutation(
            mode,
            () => {
              repo.git('mv', 'docs/index.md', 'docs/overview.md');
            },
            'docs: rename index',
          ),
          'true',
        );
      });
    },
  );

  describe('unsupported and malformed invocations', () => {
    it.each([
      ['workflow_dispatch'],
      ['schedule'],
      ['pull_request_target'],
      ['merge_group'],
    ])('classifies the %s event as not docs-only', (event) => {
      expectClassification(repo.classify(event, 'main', 'main'), 'false');
    });

    it('classifies an invocation with no arguments as not docs-only', () => {
      expectClassification(repo.classify(), 'false');
    });

    it('classifies an empty event name as not docs-only', () => {
      expectClassification(repo.classify('', initial, initial), 'false');
    });

    it('classifies a supported event outside a Git repository as not docs-only', () => {
      const outside = createNonRepoDir();

      try {
        expectClassification(
          classifyIn(outside.dir, 'push', initial, initial),
          'false',
        );
        expectClassification(
          classifyIn(outside.dir, 'pull_request', 'main', 'feature'),
          'false',
        );
      } finally {
        outside.cleanup();
      }
    });
  });
});
