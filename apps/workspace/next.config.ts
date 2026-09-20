import { join } from 'node:path';

import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
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
