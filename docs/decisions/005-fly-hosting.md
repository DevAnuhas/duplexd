# 005: Fly.io for the server

Status: superseded by 010
Date: 2026-09-15

## Context

A live session is a long-lived connection: a WebSocket to the provider, a WebRTC signaling exchange or a telephony media stream on the other side, lasting minutes. The instance that opened the provider connection must keep it for the life of the call. Consumers or the provider may require EU data residency; the provider offers an EU SIP endpoint.

## Decision

The server deploys to Fly.io from a Dockerfile, with sessions pinned to the machine that owns their provider connection. Postgres is Neon. The console is served as static files by the same app in milestone 1.

## Alternatives

**Vercel or another serverless platform for the server.** Rejected: execution-time ceilings and the inability to hold a WebSocket open for a multi-minute call. Fine for the console later.

**Self-managed VM.** Rejected for now: more operations for no functional gain at this scale. Reopen if Fly's pricing or regional options stop fitting.

**Kubernetes.** Rejected: nothing here needs it.

## Consequences

Horizontal scale is by machine count; a session never migrates. A deploy that restarts a machine ends the calls on it. Rolling deploys and drain time are an operational requirement before any real traffic, not an optimization.

Region choice is per deployment and must match the provider endpoint used (`sip.api.openai.com` versus `sip-eu.api.openai.com`) when SIP is in play.

Nothing is deployed until milestone 1 works locally. This ADR fixes the target so the first deployment does not improvise.
