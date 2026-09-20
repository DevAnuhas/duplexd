import { join } from 'node:path';

import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  /**
   * Partial prerendering is **off**, deliberately. Do not switch these on
   * without reading #52 first.
   *
   * With `cacheComponents: true`, **a client component delivered through a
   * streamed `<Suspense>` boundary never hydrates.** The markup renders
   * correctly and every control inside it is inert — sign out, the theme
   * toggle, Save, Mint a key — with no console error, in production and on
   * Vercel. It was isolated to a single variable on a stock probe: a bare root
   * layout, one Suspense, one async server component, one client button,
   * outside any route group. Flag on, dead; flag off, it hydrates and the
   * click counts.
   *
   * A static island *with data streamed into it as a child* does hydrate, and
   * that half was proven too — but a streamed child cannot execute
   * JavaScript, so it can never seed a mounted form. Since almost every
   * control here is fed by session-derived values, the shipping shape is the
   * plain one: pages `await` their data and render it into the initial HTML,
   * with `dynamic = 'force-dynamic'` on every segment that reads the session.
   *
   * What that costs is the prerendered shell. What it buys is a workspace
   * whose buttons work. #52 carries the route back to partial prerendering,
   * which needs forms to load their values client-side after hydration.
   */
  cacheComponents: false,
  /** Off with `cacheComponents`: the two were adopted and reverted together. */
  partialPrefetching: false,
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
