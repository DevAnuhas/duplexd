# Operations

Hosting and environments. Nothing here is deployed; this records the intended shape so the first deployment does not improvise it.

## Local

The workspace app and its database are what runs locally; the agent runs against Pipecat Cloud rather than on the developer's machine. Nothing runs locally at this commit — P02 adds the first thing that does.

Tool webhooks are called from the agent, not from the developer's machine, so a locally developed webhook needs to be reachable from the internet. Use `ngrok` or `cloudflared`. Do not commit tunnel URLs.

## Hosted

**Workspace and control API: Fly.io.** A Node server rather than serverless, because the control API keeps live event streaming available later without a rewrite, because a Dockerfile deploy is simple, because regions include the EU for data residency, and because idle cost is low. [ADR 005](decisions/005-fly-hosting.md) is superseded as written — it chose Fly for the retired engine's server — but its choice survives for the app that replaces it.

**Agent: Pipecat Cloud.** The agent image is built and deployed by `pipecat cloud deploy`, with the provider key and the platform token held in a Pipecat Cloud secret set. `min_agents = 0` at launch, with `max_agents` set as a cost guard; cold start is measured on a real call rather than paid for in advance. Self-hosted regions are available if pricing or data residency demands them.

**Database: Neon.** Postgres with Drizzle migrations. Branch per preview if useful.

**Secrets:** Fly secrets for the database URL and the encryption key that protects customers' webhook secrets at rest. Pipecat Cloud secrets for the provider key. Never in an image, never in the repository.

## Environments

| Environment | Source | Purpose |
| --- | --- | --- |
| Preview | Each pull request, when CI exists | Ephemeral, synthetic tool webhooks, no real telephony |
| Staging | `main` | Shared verification with real provider access and test numbers |
| Production | Tagged release | Human approval required |

Preview environments never hold production keys or real phone numbers.

## Telephony provisioning

Twilio numbers, SIP trunks, and the provider's SIP enablement are paid or externally gated. Provisioning them is an authorized human step, recorded in the relevant issue. Test numbers stay in staging.

## Observability

The platform's own `call_id` is the join key across call records, agent logs, Pipecat Cloud sessions, and any telephony provider's call id. Log it on every call event. Never log audio, transcripts in full, API keys, or a customer's webhook secret.
