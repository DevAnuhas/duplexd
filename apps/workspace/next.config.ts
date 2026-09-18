import { join } from 'node:path';

import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Standalone output is what the Dockerfile copies: a self-contained server
  // that does not need the whole node_modules tree at runtime.
  output: 'standalone',
  // Absolute: Next warns and ignores a relative value here. The root is the
  // repository, because standalone tracing has to reach the pnpm workspace's
  // hoisted node_modules two levels up.
  outputFileTracingRoot: join(import.meta.dirname, '..', '..'),
};

export default nextConfig;
