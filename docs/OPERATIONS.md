# Operations

Hosting and environments. Repository configuration exists, but the owner dashboard actions and first real deployment are still unverified. [DEPLOYMENT.md](DEPLOYMENT.md) is the canonical setup and recovery runbook.

## Local

The workspace app is what runs locally; the agent runs against Pipecat Cloud rather than on the developer's machine.

**A Neon branch per developer is the documented default, and any PostgreSQL 17 or newer works.** `DATABASE_URL` is a connection string and nothing in the app special-cases what answers it. Neon is the default because it matches production exactly — same major version, pooler, TLS — and branching gives each developer an isolated database in seconds; anyone without a Neon account points `DATABASE_URL` at a local server and loses nothing. `docker-compose.yml` was deleted in P01 and is not restored: it existed to run Postgres for the retired Fastify server.

Tool webhooks are called from the agent, not from the developer's machine, so a locally developed webhook needs to be reachable from the internet. Use `ngrok` or `cloudflared`. Do not commit tunnel URLs.

## Hosted

**Workspace and control API: Vercel.** Next.js pages and route handlers run as serverless functions; the live media path belongs to the Pipecat agent, so the platform has no long-lived socket that justifies a permanent server. [ADR 011](decisions/011-vercel-hosting.md) records the decision and supersedes ADR 005 for this layer.

**Agent: Pipecat Cloud.** The agent image is built and deployed by `pipecat cloud deploy` from `agent/`, which uses Pipecat Cloud Build when `pcc-deploy.toml` names no image, with the provider key and the platform token held in the `duplexd-agent-secrets` secret set. `min_agents = 0` and `max_agents = 1`; cold start is measured on a real call rather than paid for in advance. Every deploy produces a new deployment UUID, which must be written back to `PIPECAT_DEPLOYMENT_ID` wherever the workspace runs — see [DEPLOYMENT.md](DEPLOYMENT.md). Self-hosted regions are available if pricing or data residency demands them.

**Database: Neon.** Postgres with Drizzle migrations. The Neon-Managed Vercel integration gives each preview an isolated branch; production migration is staged before promotion. See [DEPLOYMENT.md](DEPLOYMENT.md).

**Secrets:** Vercel environment variables hold five app-wide runtime requirements—`DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `ASSISTANT_SECRET_KEY`, and `PIPECAT_API_KEY`—plus the route-required `CALL_SWEEP_TOKEN`. Preview builds additionally require integration-injected `DATABASE_URL_UNPOOLED` and the configured `NEON_PRODUCTION_BRANCH_ID`. GitHub holds the narrowly scoped deploy, migration, and scheduler credentials listed in [DEPLOYMENT.md](DEPLOYMENT.md). Pipecat Cloud separately holds the model/provider key used by the running agent. Never in an image or repository.

The five app-wide variables are required and none is defaulted. Serverless registration throws when one is missing, so every affected function invocation fails with 500 and the platform logs name the missing variable; there is no permanent application port to release. `CALL_SWEEP_TOKEN` is checked only by the sweep route: absence produces a uniform 401 and a server-side configuration log while unrelated routes keep serving. `BETTER_AUTH_URL` is the public origin, never derived from the request, because behind a proxy the `Host` header would decide what the deployment thinks it is.

**Migrations never run at function startup.** Previews preflight and migrate only their isolated Neon branch during build. Production uses the repository workflow to build without a domain, migrate once, then promote. The order is structural rather than a dashboard convention.

## Environments

| Environment | Source                                          | Purpose                                               |
| ----------- | ----------------------------------------------- | ----------------------------------------------------- |
| Preview     | Each pull request                               | Ephemeral, synthetic tool webhooks, no real telephony |
| Production  | `main` through the protected GitHub environment | Real traffic after staged migration and promotion     |

Preview environments never hold production keys or real phone numbers.

## Webhook targets

**An assistant's server URL is rejected at save if it points inside a private network.** The webhook is called by the platform, from the platform's network, so a private, loopback or link-local target is not the customer's service — it is ours, reached with our credentials from inside our perimeter. `169.254.169.254` is the cloud instance metadata endpoint on every major provider, and reaching it from a server-side fetch is how credentials walk out of a deployment.

Refused: `127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `0/8`, and for IPv6 `::1`, `::`, `fc00::/7` and `fe80::/10`. An IPv4 address wearing an IPv6 spelling — IPv4-mapped, NAT64 or 6to4 — is unwrapped first and judged by the address it carries, not the notation.

**`ALLOW_LOOPBACK_SERVER_URL` is the one knob that opens this, and it must never be set in a hosted environment.** Set to the literal `true`, it permits loopback targets for local development. It is off unless set, and a deployment that sets nothing refuses them — a default-on development exception is a production hole waiting for someone to not set the variable, and it fails silently, looking like working software.

This check covers **literal addresses only and performs no DNS**. A hostname that resolves to a private address is not caught here, deliberately: a save-time lookup stops no attacker, because anyone aiming the platform's egress at internal infrastructure controls their own record and can point it public for the save and private a minute later. The defence that works is at egress — resolve, refuse non-globally-routable addresses, and pin the connection to the address that was checked — and it lives with the agent runtime. This is the earlier, cheaper half, not a substitute.

## Telephony provisioning

Twilio numbers, SIP trunks, and the provider's SIP enablement are paid or externally gated. Provisioning them is an authorized human step, recorded in the relevant issue. Test numbers stay in staging.

## Observability

The platform's own `call_id` is the join key across call records, agent logs, Pipecat Cloud sessions, and any telephony provider's call id. Log it on every call event. Never log audio, transcripts in full, API keys, or a customer's webhook secret.

**The database layer enforces the last part of that rule rather than trusting it.** A failing query carries its bound parameters into the error it throws, so `src/db/redact.ts` wraps the client and strips every bound value from the error's message, its stack, and its own properties before anything can log it — keeping the parameterised SQL and pg's diagnostics, which carry no values. It strips _all_ parameters rather than secret-shaped ones, because from P05 the payloads written to `call_events` are transcripts, and a failing insert there would otherwise put a caller's own words into the log aggregator. If you add a database client rather than using `getDb()`, you leave that protection behind.

An API key cannot be recovered. The row holds a prefix and a hash, so support cannot read a customer's key back to them — a lost key is replaced by minting a new one and revoking the old. Revocation is a soft delete: the row survives so calls already made with it stay attributable.

## What bounds a Sandbox voice call

Sandbox execution is enabled by server configuration ([ADR 015](decisions/015-server-configured-sandbox-execution.md)). The bound on a running call is operational, and it is worth being precise about which parts are enforced where, because three of the five are ours and only two belong to the provider:

| Bound | Enforced by | Effect |
| --- | --- | --- |
| Execution deadline, 600 s from dispatch | Platform, durable on the call row | `advanceSandboxExecution` requests a stop; the call ends `execution_deadline` |
| Daily room expiry, set to the same instant with `eject_at_room_exp` | Provider | The browser and the agent are ejected from the room |
| Presence lease, 60 s, renewed every 15 s by the tab | Platform | A closed or hidden tab ends the call rather than leaving it running |
| Startup deadline, 120 s | Platform | An agent that never reaches readiness ends the call `startup_deadline` |
| Watchdog, polling control every 3 s | Agent | The agent stops itself when the platform says stop |
| Sweep, every five minutes | Platform + provider private API | Unresolved sessions get a session `DELETE`, up to three attempts |
| `max_agents = 1`, spend cap | Provider | A bug cannot fan out into many paid sessions |

**Pipecat's deploy configuration has no session-duration field.** `pcc-deploy.toml` accepts `min_agents`, `max_agents`, the secret set, the profile and the region, and nothing else that bounds a session's length. Anything claiming a provider-enforced session ceiling is describing the room expiry above, which is a Daily room property this platform sets per start — so the ceiling holds because the start request sets it, not because the deployment does.

Termination is never inferred. A `DELETE` acknowledgement, a 404, an empty listing or elapsed time are all non-evidence; only a session read reporting `endedAt` with a completion status marks a resource confirmed stopped.

## Call liveness and recovery

The workspace owns no timer. GitHub Actions calls the authenticated sweep endpoint every five minutes, and can call it manually or repeatedly without harm. GitHub may disable schedules after 60 days of repository inactivity, so read paths independently derive stale state: a late sweep delays persistence only and never makes a stale call read as active.

Every accepted event batch, including an empty heartbeat batch, advances `last_heartbeat_at`. On a sweep:

- an `active` call whose heartbeat is more than two minutes old becomes `incomplete` with `ended_reason = agent_lost`. The agent has not reported an authoritative duration before `/complete`, so a production-shaped incomplete call retains `duration_secs = NULL`; the sweeper does not estimate a duration from timestamps;
- a `starting` call more than two minutes old becomes `failed` with `ended_reason = agent_never_started`.

The starting threshold is provisional. The real cold-start measurement requires a Pipecat Cloud deployment with `min_agents = 0`; without those credentials it is blocked, not estimated. Revisit the threshold after that measurement rather than treating two minutes as provider evidence.

The sweeper appends its terminal observation in the platform-owned sequence range beginning at `1_000_000_000`. Agent events must stay below that boundary, so an in-flight agent batch cannot collide with a platform event. A later agent event is still stored because it is a real observation. A later `/complete` corrects `incomplete` to `ended` with the agent's reason and duration: only the agent can authoritatively say a call finished.
