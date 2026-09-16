import { defineConfig } from 'vitest/config';

/**
 * Root-level suite for repository tooling that lives outside any workspace
 * package — currently `scripts/classify-docs-only.sh`.
 *
 * `include` is scoped to `tests/` on purpose: without it the root runner would
 * also collect every package's `test/` suite and run it from the wrong working
 * directory. Package suites are owned by each package's own `vitest.config.ts`.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
