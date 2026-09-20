import { getSessionCookie } from 'better-auth/cookies';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Redirects signed-out visitors to `/sign-in` before a workspace page renders.
 *
 * **This is a redirect, not an authorization check, and the distinction is the
 * whole reason this file needs a comment.** `getSessionCookie` reads whether a
 * cookie is *present*. It does not verify the signature, does not look the
 * session up, and does not touch the database — anyone can set a cookie of the
 * right name by hand and get past this function. Nothing here may ever be the
 * only thing standing between a request and a tenant's data.
 *
 * What actually scopes every read and write is `getCurrentAccount()`, which
 * resolves the account from the server-side session and from nothing the caller
 * can set. Every page under `(app)` still calls it inside its own Suspense
 * boundary, and still redirects on its own when there is no session. This file
 * changes when that redirect happens, never whether it happens: delete it and
 * the pages are exactly as safe, just slower to bounce.
 *
 * ## Why it exists at all
 *
 * Under `cacheComponents` the prerendered shell is served with **200** and the
 * page's own redirect arrives in the streamed body. That is correct and it
 * leaks nothing — the shell is built with no database and no session, so it
 * carries no account id, no email and no organization name — but it costs two
 * things worth keeping. A client with no JavaScript never runs the streamed
 * redirect and simply sits on an empty frame; and `GET /` stopped answering
 * `307`, which is the contract `test/control-live-server.test.ts` asserts
 * against a real production server.
 *
 * So the cookie check restores the fast, JavaScript-free bounce, and the real
 * check stays where it always was.
 *
 * ## Two things not to change without reading this
 *
 * `getSessionCookie` matches `__Secure-better-auth.session_token` before the
 * unprefixed name, so it works under both schemes without being told which one
 * it is. It is passed no options because `lib/auth.ts` customizes neither
 * `cookieName` nor `cookiePrefix` — if it ever does, the same values have to be
 * passed here, because this helper does not read the auth config.
 *
 * Nothing in this module reads `process.env`, at module scope or inside the
 * function. Proxy code is bundled separately and may be deployed to a CDN edge,
 * so it cannot rely on the server's environment, and `next build` has to keep
 * succeeding with no database URL and no auth secret present.
 */
export function proxy(request: NextRequest): NextResponse {
  if (getSessionCookie(request) !== null) {
    return NextResponse.next();
  }

  const signIn = new URL('/sign-in', request.url);

  // 307 rather than 308: the redirect is a property of this request's missing
  // cookie, not of the URL, and it must never be cached as permanent.
  return NextResponse.redirect(signIn, 307);
}

/**
 * The `(app)` routes, listed rather than derived — and listed as an **allowlist
 * of what to protect**, not a denylist of what to skip.
 *
 * The denylist is the obvious way to write this and it is the dangerous one. I
 * wrote it first, as `/((?!api|v1|sign-in|sign-up|_next/...).*)`, and it
 * silently swallowed `/reset-password`: the page a signed-out person opens from
 * a password-reset email, which would have been redirected to `/sign-in` with
 * their token dropped on the floor. Password reset would have shipped broken,
 * and no test in this repository would have said so.
 *
 * Compare how the two fail when somebody adds a route and forgets this file:
 *
 *  - **Denylist** — a new *public* page starts redirecting signed-out visitors
 *    to `/sign-in`. The flow is broken for exactly the people it exists for.
 *  - **Allowlist** — a new *protected* page is not listed here, so it serves
 *    its prerendered shell and redirects from inside its own Suspense boundary,
 *    which is what every page did before this file existed. Slower, not weaker.
 *
 * The second is the failure worth having, so the protected set is spelled out.
 * Each route is listed twice because `:path*` covers the children and it is not
 * worth anybody's time to re-derive whether it also covers the bare segment.
 *
 * Nothing outside this list reaches the proxy at all — not `/sign-in`, not
 * `/api/*` (Better Auth's own routes, including the POST that issues the cookie
 * this file looks for), not `/v1/*` (API-key and agent-token callers, which
 * answer `401` with a problem document and must never be sent an HTML
 * redirect), and not `/_next/*` or any static asset.
 */
export const config = {
  matcher: [
    '/',
    '/assistants',
    '/assistants/:path*',
    '/calls',
    '/calls/:path*',
    '/keys',
    '/keys/:path*',
    '/settings',
    '/settings/:path*',
  ],
};
