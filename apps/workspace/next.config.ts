import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Standalone output is what the Dockerfile copies: a self-contained server
  // that does not need the whole node_modules tree at runtime.
  output: 'standalone',
  outputFileTracingRoot: '../../',
};

export default nextConfig;
