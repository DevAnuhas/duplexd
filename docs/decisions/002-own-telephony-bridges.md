# 002: Own the telephony bridges

Status: accepted
Date: 2026-09-15

## Context

Phone calls reach a full-duplex model either through a partner SDK that bridges the telephony provider's media stream, through the provider's direct SIP endpoint, or through an application-owned bridge. Twilio ships an open-source SDK with a GPT-Live provider, but it is Python-only and built around Responses delegation. LiveKit and Pipecat have GPT-Live plugins that bring their own runtime and, in LiveKit's case, a media server.

The audio bridge itself is small: Twilio Media Streams deliver G.711 μ-law at 8 kHz, which GPT-Live accepts unchanged over WebSocket, so the bridge is envelope translation and lifecycle, not signal processing.

## Decision

duplexd implements its own transport adapters: a Twilio Media Streams bridge and a direct SIP adapter using the provider's webhook and attach endpoints. No partner SDK is a dependency of the core or the server.

## Alternatives

**Twilio Agent Connect.** Rejected: wrong language for the core, wrong delegation mode by default, and it brings Conversation Orchestrator and Memory concepts this product deliberately leaves to the consumer.

**LiveKit Agents.** Deferred, not rejected. It becomes worth its weight when concurrency, multi-participant rooms (a human listening in), or LiveKit's native SIP and numbers are needed. Adding it then is a transport adapter, which is why the transport interface exists.

**Pipecat.** Rejected: pipeline abstraction designed for cascades; the parts it adds (turn detection, processor graphs) are what a full-duplex model makes unnecessary.

## Consequences

The transports package must own audio ordering, playback buffering, interruption of queued audio, and call teardown for each provider. Those are the parts partner SDKs would have handled.

Each transport requires a recorded live session before merge, per `docs/ENGINEERING.md`. A bridge that works against a mocked event stream has proven nothing about timing.

Direct SIP depends on the provider enabling it per project. Until that is confirmed for the deploying project, the SIP adapter cannot be verified live and is reported as blocked.
