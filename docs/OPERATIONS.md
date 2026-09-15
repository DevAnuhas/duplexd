# Operations

Hosting and environments. Nothing here is deployed; this records the intended shape so the first deployment does not improvise it.

## Local

Everything in milestone 1 runs on one machine: the server, the console, a Postgres container, and an example handler. Only `OPENAI_API_KEY` is external. WebRTC from a local browser to the provider needs no tunnel.

Telephony transports, when they exist, need the server reachable from the internet for webhooks and media streams. Use `ngrok` or `cloudflared` for development. Do not commit tunnel URLs.

## Hosted

**Server: Fly.io.** Chosen because sessions are long-lived WebSocket and WebRTC signaling connections lasting minutes, which serverless platforms cannot hold; because a Dockerfile deploy is simple; because regions include the EU, which matters when a consumer or the provider requires EU data residency; and because idle cost is low. Sessions are pinned to the instance holding the provider connection, so scale by adding machines, not by moving sessions.

**Database: Neon.** Same Postgres, same Drizzle migrations as local. Branch per preview if useful.

**Console:** static build served by the same Fly app in milestone 1. Splitting it to Vercel or a CDN is a later choice and an ADR.

**Secrets:** Fly secrets for the provider key and database URL. Never in the image, never in the repo.

## Environments

| Environment | Source | Purpose |
| --- | --- | --- |
| Preview | Each pull request, when CI exists | Ephemeral, synthetic handlers, no real telephony |
| Staging | `main` | Shared verification with real provider access and test numbers |
| Production | Tagged release | Human approval required |

Preview environments never hold production keys or real phone numbers.

## Telephony provisioning

Twilio numbers, SIP trunks, and the provider's SIP enablement are paid or externally gated. Provisioning them is an authorized human step, recorded in the relevant issue. Test numbers stay in staging.

## Observability

Session id from the provider is the join key across duplexd records, provider support, and any telephony provider's call id. Log it on every session event. Never log audio, transcripts in full, or API keys.
