import { defineConfig } from 'vitest/config';

/**
 * Shared Vitest configuration for every TypeScript workspace package.
 *
 * Packages run their smoke tests from `test/`, never `src/`, so `tsc -b`
 * (rootDir `src`, include `src/**`) never emits test files into `dist`.
 * The environment is pinned to Node explicitly: T01 ships no DOM/UI behavior,
 * so no workspace — the console included — may quietly switch to jsdom.
 */
export const sharedPackageTestConfig = defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});

export default sharedPackageTestConfig;
