import { redirect } from 'next/navigation';
import { Suspense } from 'react';

import { getCurrentAccount } from '@/lib/account';

/**
 * The root path is a signpost, not a page.
 *
 * There is no dashboard to show: assistants are what a tenant comes here to
 * manage, so `/` sends them there. It sits *outside* the `(app)` route group
 * deliberately — it renders nothing, so wrapping it in the shell would build a
 * sidebar for a response that is only ever a redirect.
 *
 * The session read sits inside a `<Suspense>` boundary because under
 * `cacheComponents` a request-time read outside one is a build error. There is
 * nothing to show while it resolves — both outcomes are redirects — so the
 * fallback is empty rather than a skeleton of a page that will never paint.
 */
export default function RootPage() {
  return (
    <Suspense fallback={null}>
      <RootRedirect />
    </Suspense>
  );
}

/**
 * `redirect()` throws, so nothing after it runs — but its `never` return type
 * makes this component infer `Promise<void>`, which is not a valid JSX element
 * type. The explicit `null` is what makes it one.
 */
async function RootRedirect(): Promise<null> {
  redirect((await getCurrentAccount()) === null ? '/sign-in' : '/assistants');
}
