import { fileURLToPath } from "node:url"

import { defineConfig } from "vitest/config"

/**
 * The workspace app's suite. Scoped to `test/` so it never picks up the root
 * repository suite, which has its own runner at the repository root.
 *
 * `fileParallelism` is off and it is load-bearing, not a performance choice.
 * `test/migrations.test.ts` drops and recreates the `public` schema to prove
 * migrations apply from a genuinely empty database; running that alongside any
 * other database-backed file would delete the rows it is asserting about. Every
 * file that needs data seeds its own, so serial execution is sufficient — no
 * file may depend on another file's rows.
 *
 * Timeouts are generous because the default database is a Neon branch, which
 * can take several seconds to wake from idle on the first connection.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    setupFiles: ["test/setup.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
})
