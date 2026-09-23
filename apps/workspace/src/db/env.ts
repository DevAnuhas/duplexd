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
  const url = process.env.DATABASE_URL

  if (url === undefined || url.trim() === "") {
    throw new Error(
      "DATABASE_URL is unset or empty. Set it to a PostgreSQL connection " +
        "string. It is never defaulted: an empty value would connect to a " +
        "local database instead of failing."
    )
  }

  return url
}

/**
 * The 32-byte key protecting assistants' webhook secrets at rest, as hex.
 *
 * Wrong length is an error rather than a silently padded or truncated key, and
 * there is no fallback to a built-in default — a default key is the same as no
 * encryption, with the added problem that it looks encrypted.
 */
export function requireEncryptionKey(): Buffer {
  const hex = process.env.ASSISTANT_SECRET_KEY

  if (hex === undefined || hex.trim() === "") {
    throw new Error(
      "ASSISTANT_SECRET_KEY is unset or empty. It must be 32 bytes of random " +
        "data, hex-encoded (64 characters)."
    )
  }

  if (!/^[0-9a-fA-F]{64}$/.test(hex.trim())) {
    throw new Error(
      "ASSISTANT_SECRET_KEY must be exactly 64 hex characters (32 bytes). " +
        `Received ${hex.trim().length} characters.`
    )
  }

  return Buffer.from(hex.trim(), "hex")
}

/** The Better Auth signing secret, or an error naming it. */
export function requireAuthSecret(): string {
  const secret = process.env.BETTER_AUTH_SECRET

  if (secret === undefined || secret.trim() === "") {
    throw new Error("BETTER_AUTH_SECRET is unset or empty.")
  }

  return secret
}

/**
 * Better Auth's allowlisted, per-request base URL. Structural rather than
 * imported so this module stays free of an auth dependency; the shape is
 * Better Auth's `DynamicBaseURLConfig`.
 */
export type DynamicAuthBaseUrl = {
  allowedHosts: string[]
  protocol: "https"
  fallback: string
}

/** `BETTER_AUTH_URL` when it is set to something, otherwise `undefined`. */
function explicitAuthUrl(): string | undefined {
  const url = process.env.BETTER_AUTH_URL?.trim()

  return url ? url : undefined
}

/**
 * The hostnames a Vercel preview answers on, most stable first, deduplicated.
 *
 * Empty off Vercel and on production, which is what keeps the fallback
 * preview-only. Both callers below read this rather than the variables, so
 * "which hosts count" has one definition; two would drift, and the one that
 * drifted would be the one nobody was looking at.
 */
function previewHosts(): string[] {
  if (process.env.VERCEL_ENV !== "preview") {
    return []
  }

  const hosts = [process.env.VERCEL_BRANCH_URL, process.env.VERCEL_URL]
    .map((host) => host?.trim())
    .filter((host): host is string => Boolean(host))

  return [...new Set(hosts)]
}

/** The one error both accessors raise, so the message cannot drift. */
function missingAuthUrl(): Error {
  return new Error(
    "BETTER_AUTH_URL is unset or empty. Set it to the origin the app is " +
      "served from, for example http://localhost:3000. It is not derived " +
      "from the request, because behind a proxy the request does not decide " +
      "what this deployment is. Vercel preview deployments may instead leave " +
      "it unset and let VERCEL_BRANCH_URL and VERCEL_URL supply the origins."
  )
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
 * The preview hosts are not the request's `Host` header. They are injected by
 * the platform and name this deployment, so the deployment still states its
 * own identity rather than inferring it from traffic — it reads that identity
 * from the platform instead of a dashboard field.
 *
 * This returns **one** origin, for the callers that need a single URL to hand
 * to something else: the agent's `apiBase` has to be one address it can call
 * back on. The branch URL is preferred because it survives a redeploy of the
 * same pull request. Auth itself needs both hosts and uses
 * {@link resolveAuthBaseUrl}.
 *
 * **Only previews.** A production deployment missing this must still fail
 * loudly, rather than quietly minting cookies for a `vercel.app` domain
 * instead of the real one — which is the failure that does not surface until
 * someone cannot stay signed in.
 */
export function requireAuthUrl(): string {
  const explicit = explicitAuthUrl()

  if (explicit !== undefined) {
    return explicit
  }

  const [preferred] = previewHosts()

  if (preferred !== undefined) {
    return `https://${preferred}`
  }

  throw missingAuthUrl()
}

/**
 * Better Auth's base URL: one origin normally, both preview hosts on Vercel.
 *
 * A Vercel preview answers on **two** hostnames that both legitimately serve
 * it — the stable branch URL and the per-deployment URL — and Vercel's
 * dashboard and pull-request comments link the per-deployment one. Better
 * Auth's origin check compares the request's `Origin` against the configured
 * base URL, so pinning either host rejects the other with `403 Invalid
 * origin`. That is what a single-host preview fallback produced, and it stayed
 * invisible to a check that requested the branch URL with a matching `Origin`
 * header — the one path that fallback was built for.
 *
 * `DynamicBaseURLConfig` is Better Auth's answer to this, documented for
 * Vercel previews by name. The base URL becomes per-request but **allowlisted**
 * to origins this deployment already knows about, so the distinction the
 * comment above draws still holds: the request may pick between our hosts, it
 * cannot name one.
 *
 * `allowedHosts` carries exact hostnames and never a wildcard. `*.vercel.app`
 * would match every deployment on the platform, including other people's.
 *
 * Production keeps a plain string. It has a single hostname, so a per-request
 * base URL would put a request header into the auth decision for no benefit.
 */
export function resolveAuthBaseUrl(): string | DynamicAuthBaseUrl {
  const explicit = explicitAuthUrl()

  if (explicit !== undefined) {
    return explicit
  }

  const hosts = previewHosts()
  const [preferred] = hosts

  if (preferred !== undefined) {
    return {
      allowedHosts: hosts,
      protocol: "https",
      fallback: `https://${preferred}`,
    }
  }

  throw missingAuthUrl()
}

/** Pipecat Cloud API key used only by the server-side start request. */
export function requirePipecatApiKey(): string {
  const key = process.env.PIPECAT_API_KEY

  if (key === undefined || key.trim() === "") {
    throw new Error("PIPECAT_API_KEY is unset or empty.")
  }

  return key.trim()
}

/**
 * The origin the **agent** calls back on: `/v1/agent/*` and `/v1/practice/*`.
 *
 * Normally identical to {@link requireAuthUrl}, and on Vercel it always is —
 * which is why this is a single optional override rather than a second
 * required variable.
 *
 * It exists for local development, where the two origins genuinely differ. The
 * browser reaches the workspace at `http://localhost:3000`, and
 * `BETTER_AUTH_URL` has to stay that, because it decides the cookie domain and
 * the `__Secure-` prefix. The agent runs on Pipecat Cloud and reaches the same
 * workspace through an HTTPS tunnel; it cannot resolve `localhost`, and the
 * transport refuses a non-HTTPS `apiBase` outright. Pointing `BETTER_AUTH_URL`
 * at the tunnel instead would fix the agent and break sign-in.
 *
 * Set it to the tunnel origin for a local run; leave it unset everywhere else.
 */
export function resolveSandboxAgentApiBase(): string {
  return trimmed("SANDBOX_AGENT_API_BASE") ?? requireAuthUrl()
}

/**
 * The five values that let this deployment dispatch a real Sandbox call.
 *
 * Structural rather than importing `SandboxBinding`, for the same reason
 * {@link DynamicAuthBaseUrl} is structural: this module stays a leaf that reads
 * the environment and nothing else. `sandbox/provider.ts` maps it onto the
 * transport's binding.
 */
export type SandboxProviderEnvironment = {
  publicApiKey: string
  privateApiKey: string
  organizationId: string
  serviceId: string
  deploymentId: string
}

const PIPECAT_BINDING_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function trimmed(name: string): string | null {
  const value = process.env[name]?.trim()

  return value === undefined || value === "" ? null : value
}

/**
 * The Sandbox provider configuration, or `null` when this deployment has none.
 *
 * **This is the switch that decides whether Sandbox execution exists.** ADR 015
 * replaced the compile-time refusal of ADR 013/014 with server configuration:
 * a deployment that has not been given all five values still answers 503 from
 * every execution-bearing route, exactly as before, because the composed
 * lifecycle has no transport to dispatch through.
 *
 * All-or-nothing on purpose. A partially configured deployment is a mistake,
 * not a half-enabled feature, and the failure it would otherwise produce — a
 * start that reaches the provider and then cannot verify which session it
 * owns — is the expensive kind: it leaves a running agent nobody is tracking.
 *
 * `PIPECAT_ORGANIZATION` is deliberately **not** read here. That variable holds
 * the Pipecat namespace (`duplexd`), and the transport compares provider
 * responses against UUIDs; a namespace in a UUID field would fail every
 * comparison and read as "someone else's session".
 *
 * The two keys must differ. They are different credentials with different
 * authority — the public one starts sessions, the private one reads and
 * terminates them — and the same value in both fields means one of them was
 * pasted into the wrong variable.
 */
export function readSandboxProviderEnvironment(): SandboxProviderEnvironment | null {
  const publicApiKey = trimmed("PIPECAT_API_KEY")
  const privateApiKey = trimmed("PIPECAT_PRIVATE_API_KEY")
  const organizationId = trimmed("PIPECAT_ORGANIZATION_ID")
  const serviceId = trimmed("PIPECAT_SERVICE_ID")
  const deploymentId = trimmed("PIPECAT_DEPLOYMENT_ID")

  if (
    publicApiKey === null ||
    privateApiKey === null ||
    publicApiKey === privateApiKey ||
    organizationId === null ||
    serviceId === null ||
    deploymentId === null ||
    ![organizationId, serviceId, deploymentId].every((value) =>
      PIPECAT_BINDING_UUID.test(value)
    )
  ) {
    return null
  }

  return {
    publicApiKey,
    privateApiKey,
    organizationId,
    serviceId,
    deploymentId,
  }
}

/**
 * Whether Sandbox execution is configured on this deployment.
 *
 * One definition, read both by the attempt projection the browser sees and by
 * the lifecycle composition that does the dispatching. Two predicates would
 * drift, and the drift would be invisible: a browser offering a Start button
 * that the server answers with 503, or the reverse.
 */
export function sandboxExecutionConfigured(): boolean {
  return readSandboxProviderEnvironment() !== null
}

/** High-entropy bearer credential protecting the external sweep endpoint. */
export function readCallSweepToken(): string | null {
  const token = process.env.CALL_SWEEP_TOKEN

  if (token === undefined || token.trim() === "") {
    return null
  }

  return token.trim()
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
  const key = process.env.RESEND_API_KEY

  return key === undefined || key.trim() === "" ? null : key.trim()
}

/** The address reset mail is sent from, e.g. `duplexd <auth@example.com>`. */
export function readEmailFrom(): string | null {
  const from = process.env.EMAIL_FROM

  return from === undefined || from.trim() === "" ? null : from.trim()
}

/**
 * Whether this deployment can actually send an email.
 *
 * Read on the server and passed to the client as a boolean — never as the
 * values themselves, which are a credential and an address.
 */
export function emailDeliveryConfigured(): boolean {
  return readResendApiKey() !== null && readEmailFrom() !== null
}
