import { redirect } from 'next/navigation';

import { getCurrentAccount } from '@/lib/account';

/**
 * The root path is a signpost, not a page.
 *
 * There is no dashboard to show: assistants are what a tenant comes here to
 * manage, so `/` sends them there. It sits *outside* the `(app)` route group
 * deliberately — it renders nothing, so wrapping it in the shell would build a
 * sidebar for a response that is only ever a redirect.
 *
 * Dynamic because it reads the session, and therefore the database. Without
 * this, `next build` would try to prerender it and would need a reachable
 * database at build time.
 */
export const dynamic = 'force-dynamic';

export default async function RootPage() {
  redirect((await getCurrentAccount()) === null ? '/sign-in' : '/assistants');
}
