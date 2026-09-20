/**
 * Environment access for anything that talks to Postgres.
 *
 * Every getter here is called at request time, never at module import. Reading
 * these at import would make `next build` require a database and an encryption
 * key, which would in turn make every deploy depend on the database being
 * reachable from the builder.
 */

/**
 * `DATABASE_URL`, or an error naming it.
 *
 * An unset or empty value must never be passed through to a Postgres client.
 * `psql` and libpq-based clients treat an empty connection string as "use the
 * defaults" and connect to the local unix socket on port 5432 — so an empty
 * variable does not fail, it quietly talks to whatever database happens to be
 * running locally. That is how an agent in this repository nearly migrated an
 * unrelated database: a shell failed to parse a `.env` line, the variable came
 * through empty, and the client connected to localhost instead of erroring.
 *
 * The host itself is deliberately not inspected. A Neon branch is the
 * documented default and any PostgreSQL 17 or newer works; `DATABASE_URL` is a
 * connection string and nothing here special-cases what answers it.
 */
export function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;

  if (url === undefined || url.trim() === '') {
    throw new Error(
      'DATABASE_URL is unset or empty. Set it to a PostgreSQL connection ' +
        'string. It is never defaulted: an empty value would connect to a ' +
        'local database instead of failing.',
    );
  }

  return url;
}

/**
 * The 32-byte key protecting assistants' webhook secrets at rest, as hex.
 *
 * Wrong length is an error rather than a silently padded or truncated key, and
 * there is no fallback to a built-in default — a default key is the same as no
 * encryption, with the added problem that it looks encrypted.
 */
export function requireEncryptionKey(): Buffer {
  const hex = process.env.ASSISTANT_SECRET_KEY;

  if (hex === undefined || hex.trim() === '') {
    throw new Error(
      'ASSISTANT_SECRET_KEY is unset or empty. It must be 32 bytes of random ' +
        'data, hex-encoded (64 characters).',
    );
  }

  if (!/^[0-9a-fA-F]{64}$/.test(hex.trim())) {
    throw new Error(
      'ASSISTANT_SECRET_KEY must be exactly 64 hex characters (32 bytes). ' +
        `Received ${hex.trim().length} characters.`,
    );
  }

  return Buffer.from(hex.trim(), 'hex');
}

/** The Better Auth signing secret, or an error naming it. */
export function requireAuthSecret(): string {
  const secret = process.env.BETTER_AUTH_SECRET;

  if (secret === undefined || secret.trim() === '') {
    throw new Error('BETTER_AUTH_SECRET is unset or empty.');
  }

  return secret;
}

/**
 * The public origin the app is served from, or an error naming it.
 *
 * Required rather than optional. Better Auth will happily derive this from the
 * incoming request when it is absent, but that means the origin used to build
 * callback and cookie URLs is chosen by whatever `Host` header arrives — and
 * behind a proxy, that is not something the application controls. Pinning it
 * makes the deployment state its own identity instead of inferring it from
 * traffic.
 *
 * `.env.example` distinguishes the five app-wide prerequisites from values
 * that are route-required or optional. This belongs to the app-wide set:
 * every request needs one stable public origin, not an origin inferred from
 * whichever `Host` header happened to arrive.
 *
 * **Vercel previews are the one case where no value can be configured**, and
 * the fallback below does not weaken the rule above. Every pull request gets a
 * generated domain, so the Preview scope has nothing to hold that matches the
 * origin a reviewer opens: leaving it unset fails every preview at the
 * instrumentation hook, and pasting a guess is worse, because this value
 * decides the cookie domain and the `__Secure-` prefix, so a wrong origin
 * signs in and then silently fails to keep the session.
 *
 * `VERCEL_BRANCH_URL` is not the request's `Host` header. It is injected by
 * the platform and names this deployment, so the deployment still states its
 * own identity rather than inferring it from traffic — it reads that identity
 * from the platform instead of a dashboard field. It is preferred over the
 * per-deployment `VERCEL_URL` because it is stable across redeploys of the
 * same pull request, so a session survives a push; `VERCEL_URL` also does not
 * work under Standard Deployment Protection.
 *
 * **Only previews.** A production deployment missing this must still fail
 * loudly, rather than quietly minting cookies for a `vercel.app` domain
 * instead of the real one — which is the failure that does not surface until
 * someone cannot stay signed in.
 */
export function requireAuthUrl(): string {
  const url = process.env.BETTER_AUTH_URL;

  if (url !== undefined && url.trim() !== '') {
    return url.trim();
  }

  const branchHost = process.env.VERCEL_BRANCH_URL?.trim();

  if (process.env.VERCEL_ENV === 'preview' && branchHost) {
    return `https://${branchHost}`;
  }

  throw new Error(
    'BETTER_AUTH_URL is unset or empty. Set it to the origin the app is ' +
      'served from, for example http://localhost:3000. It is not derived ' +
      'from the request, because behind a proxy the request does not decide ' +
      'what this deployment is. Vercel preview deployments may instead leave ' +
      'it unset and let VERCEL_BRANCH_URL supply the origin.',
  );
}

/** Pipecat Cloud API key used only by the server-side start request. */
export function requirePipecatApiKey(): string {
  const key = process.env.PIPECAT_API_KEY;

  if (key === undefined || key.trim() === '') {
    throw new Error('PIPECAT_API_KEY is unset or empty.');
  }

  return key.trim();
}

/** High-entropy bearer credential protecting the external sweep endpoint. */
export function readCallSweepToken(): string | null {
  const token = process.env.CALL_SWEEP_TOKEN;

  if (token === undefined || token.trim() === '') {
    return null;
  }

  return token.trim();
}

/**
 * Email delivery, for password reset.
 *
 * **Both variables are optional, and that is the design.** Password reset is
 * the one feature here that depends on a third party, so the deployment
 * decides whether it exists: with both set, the flow is offered; with either
 * missing, the "Forgot your password?" link is not rendered at all.
 *
 * The alternative — always showing the link and failing at send time — puts
 * the failure in front of someone who is already locked out and can do
 * nothing about it. An absent link is honest; a link to a page that cannot
 * send is not.
 *
 * Deliberately **not** validated in `instrumentation.ts` alongside the five
 * required variables: a deployment without email must still boot.
 */
export function readResendApiKey(): string | null {
  const key = process.env.RESEND_API_KEY;

  return key === undefined || key.trim() === '' ? null : key.trim();
}

/** The address reset mail is sent from, e.g. `duplexd <auth@example.com>`. */
export function readEmailFrom(): string | null {
  const from = process.env.EMAIL_FROM;

  return from === undefined || from.trim() === '' ? null : from.trim();
}

/**
 * Whether this deployment can actually send an email.
 *
 * Read on the server and passed to the client as a boolean — never as the
 * values themselves, which are a credential and an address.
 */
export function emailDeliveryConfigured(): boolean {
  return readResendApiKey() !== null && readEmailFrom() !== null;
}
