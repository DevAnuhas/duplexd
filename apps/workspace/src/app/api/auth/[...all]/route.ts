import { toNextJsHandler } from 'better-auth/next-js';

import { getAuth } from '@/lib/auth';

/**
 * `next build` must never evaluate the auth instance, which would pull in
 * `DATABASE_URL` and `BETTER_AUTH_SECRET` at image-build time. It doesn't:
 * `getAuth()` is called inside the handler, per request. This used to also
 * carry `dynamic = 'force-dynamic'`, which `cacheComponents` rejects — under
 * it nothing is cached unless explicitly marked `'use cache'`, and a route
 * handler reading request headers is request-time by construction.
 */

export const { GET, POST } = toNextJsHandler((request: Request) =>
  getAuth().handler(request),
);
