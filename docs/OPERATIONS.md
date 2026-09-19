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

**Secrets:** Fly secrets for `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, and `ASSISTANT_SECRET_KEY` — the last of which protects customers' webhook secrets at rest. Pipecat Cloud secrets for the provider key. Never in an image, never in the repository.

All four are required and none is defaulted. The server exits at boot naming any that is missing, before it binds the port, so a deploy missing one fails visibly rather than serving 500s from a machine that looks healthy. `BETTER_AUTH_URL` belongs on that list and was previously omitted from it: it is the public origin, never derived from the request, because behind a proxy the `Host` header would decide what the deployment thinks it is.

**Migrations run as a Fly release command**, before any new machine serves traffic, so a deploy cannot serve a schema that has not been applied. The image deliberately does not migrate on boot: every container in a deploy would race the others.

## Environments

| Environment | Source | Purpose |
| --- | --- | --- |
| Preview | Each pull request | Ephemeral, synthetic tool webhooks, no real telephony |
| Staging | `main` | Shared verification with real provider access and test numbers |
| Production | Tagged release | Human approval required |

Preview environments never hold production keys or real phone numbers.

## Telephony provisioning

Twilio numbers, SIP trunks, and the provider's SIP enablement are paid or externally gated. Provisioning them is an authorized human step, recorded in the relevant issue. Test numbers stay in staging.

## Observability

The platform's own `call_id` is the join key across call records, agent logs, Pipecat Cloud sessions, and any telephony provider's call id. Log it on every call event. Never log audio, transcripts in full, API keys, or a customer's webhook secret.

**The database layer enforces the last part of that rule rather than trusting it.** A failing query carries its bound parameters into the error it throws, so `src/db/redact.ts` wraps the client and strips every bound value from the error's message, its stack, and its own properties before anything can log it — keeping the parameterised SQL and pg's diagnostics, which carry no values. It strips *all* parameters rather than secret-shaped ones, because from P05 the payloads written to `call_events` are transcripts, and a failing insert there would otherwise put a caller's own words into the log aggregator. If you add a database client rather than using `getDb()`, you leave that protection behind.

An API key cannot be recovered. The row holds a prefix and a hash, so support cannot read a customer's key back to them — a lost key is replaced by minting a new one and revoking the old. Revocation is a soft delete: the row survives so calls already made with it stay attributable.
