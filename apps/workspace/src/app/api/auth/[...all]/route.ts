import { toNextJsHandler } from 'better-auth/next-js';

import { getAuth } from '@/lib/auth';

/**
 * Dynamic so `next build` never evaluates the auth instance, which would pull
 * in `DATABASE_URL` and `BETTER_AUTH_SECRET` at image-build time.
 */
export const dynamic = 'force-dynamic';

export const { GET, POST } = toNextJsHandler((request: Request) =>
  getAuth().handler(request),
);
