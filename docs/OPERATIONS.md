# Operations

Hosting and environments. Nothing here is deployed; this records the intended shape so the first deployment does not improvise it.

## Local

The workspace app is what runs locally; the agent runs against Pipecat Cloud rather than on the developer's machine.

**A Neon branch per developer is the documented default, and any PostgreSQL 17 or newer works.** `DATABASE_URL` is a connection string and nothing in the app special-cases what answers it. Neon is the default because it matches production exactly — same major version, pooler, TLS — and branching gives each developer an isolated database in seconds; anyone without a Neon account points `DATABASE_URL` at a local server and loses nothing. `docker-compose.yml` was deleted in P01 and is not restored: it existed to run Postgres for the retired Fastify server.

Tool webhooks are called from the agent, not from the developer's machine, so a locally developed webhook needs to be reachable from the internet. Use `ngrok` or `cloudflared`. Do not commit tunnel URLs.

## Hosted

**Workspace and control API: Fly.io.** A Node server rather than serverless, because the control API keeps live event streaming available later without a rewrite, because a Dockerfile deploy is simple, because regions include the EU for data residency, and because idle cost is low. [ADR 005](decisions/005-fly-hosting.md) is superseded as written — it chose Fly for the retired engine's server — but its choice survives for the app that replaces it.

**Agent: Pipecat Cloud.** The agent image is built and deployed by `pipecat cloud deploy`, with the provider key and the platform token held in a Pipecat Cloud secret set. `min_agents = 0` at launch, with `max_agents` set as a cost guard; cold start is measured on a real call rather than paid for in advance. Self-hosted regions are available if pricing or data residency demands them.

**Database: Neon.** Postgres with Drizzle migrations. A branch per preview if useful. See the local section above for what development uses.

**Secrets:** Fly secrets for `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `ASSISTANT_SECRET_KEY`, and `PIPECAT_API_KEY` — the encryption key protects customers' webhook secrets at rest, while the Pipecat key starts the deployed agent. Pipecat Cloud separately holds the model/provider key used by the running agent. Never in an image, never in the repository.

All five are required and none is defaulted. The server exits at boot naming any that is missing, before it binds the port, so a deploy missing one fails visibly rather than serving 500s from a machine that looks healthy. `BETTER_AUTH_URL` is the public origin, never derived from the request, because behind a proxy the `Host` header would decide what the deployment thinks it is.

**Migrations run as a Fly release command**, before any new machine serves traffic, so a deploy cannot serve a schema that has not been applied. The image deliberately does not migrate on boot: every container in a deploy would race the others.

## Environments

| Environment | Source            | Purpose                                                        |
| ----------- | ----------------- | -------------------------------------------------------------- |
| Preview     | Each pull request | Ephemeral, synthetic tool webhooks, no real telephony          |
| Staging     | `main`            | Shared verification with real provider access and test numbers |
| Production  | Tagged release    | Human approval required                                        |

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

## Call liveness and recovery

The workspace arms a 30-second interval timer at server start. It does **not** sweep during boot; the first possible sweep is one full interval later. This matters because the agent runs on separate infrastructure: restarting the workspace says nothing about whether a caller is still talking.

Every accepted event batch, including an empty heartbeat batch, advances `last_heartbeat_at`. On a timer tick:

- an `active` call whose heartbeat is more than two minutes old becomes `incomplete` with `ended_reason = agent_lost`; its last reported duration is retained;
- a `starting` call more than two minutes old becomes `failed` with `ended_reason = agent_never_started`.

The starting threshold is provisional. The real cold-start measurement requires a Pipecat Cloud deployment with `min_agents = 0`; without those credentials it is blocked, not estimated. Revisit the threshold after that measurement rather than treating two minutes as provider evidence.

The sweeper appends its terminal observation in the platform-owned sequence range beginning at `1_000_000_000`. Agent events must stay below that boundary, so an in-flight agent batch cannot collide with a platform event. A later agent event is still stored because it is a real observation. A later `/complete` corrects `incomplete` to `ended` with the agent's reason and duration: only the agent can authoritatively say a call finished.
