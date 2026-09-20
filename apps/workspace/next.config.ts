import { join } from 'node:path';

import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  /**
   * Partial prerendering.
   *
   * The shell — sidebar frame, header, page chrome — is prerendered and served
   * immediately; anything that reads the session, `headers()`, `cookies()` or
   * the database streams in behind a `<Suspense>` boundary.
   *
   * **This changes what every page may write.** Under `cacheComponents` the
   * route segment configs (`dynamic`, `fetchCache`, `revalidate`,
   * `dynamicParams`, `runtime`) are build errors, and a request-time read
   * outside a Suspense boundary is also a build error. Nothing is cached
   * unless it is explicitly marked `'use cache'`, so the guarantees those
   * directives used to state are now the default rather than an opt-in.
   */
  cacheComponents: true,
  /** Prefetch the shared shell once rather than per-link. */
  partialPrefetching: true,
  // Vercel does not need standalone output. The real-server verification does:
  // it boots this artifact to prove startup and proxy-sensitive behavior against
  // a production Next server instead of Vitest's altered environment.
  output: 'standalone',
  // Absolute: Next warns and ignores a relative value here. The root is the
  // repository, because standalone tracing has to reach the pnpm workspace's
  // hoisted node_modules two levels up.
  outputFileTracingRoot: join(import.meta.dirname, '..', '..'),
};

export default nextConfig;
