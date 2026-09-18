import { defineConfig } from 'vitest/config';

/**
 * Root-level suite for repository tooling. Everything under `tests/` runs here;
 * currently that is the `scripts/classify-docs-only.sh` suite.
 *
 * `include` is scoped to `tests/` deliberately. The repository has no workspace
 * packages at this commit, but P02 adds `apps/workspace`, and a package suite
 * belongs to that package's own runner rather than to this one.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
