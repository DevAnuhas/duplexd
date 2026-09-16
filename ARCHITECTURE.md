# Architecture

Target boundaries. This describes the system as it should exist once the first milestone lands, not what exists today. `CONTEXT.md` owns status.

## The shape in one paragraph

A caller connects over some transport. duplexd opens a session with a full-duplex speech provider and relays audio between them. The provider emits transcript deltas and, when it decides it needs help, a delegation event carrying only an id. duplexd's broker takes that id, assembles the transcript so far plus consumer-supplied session context, and calls the consumer's handler. The handler streams back results. The broker forwards each result to the provider as an append: silent context the model may use, or spoken commentary the model paraphrases aloud. When the call ends, duplexd waits for the provider's final events, records usage, and closes.

## Components

```
                       ┌──────────────────────────────────────────────┐
  caller ── transport ─┤ apps/server                                   │
  (browser, phone)     │   transport adapters ── packages/core ──┐     │
                       │                          session FSM    │     │
                       │                          transcript     │     │
                       │                          delegation     │     │
                       │                          broker ────────┼──── consumer handler
                       │                                          │     (in-process or remote)
                       │   provider adapter ─── speech provider   │
                       │   records ─── PostgreSQL                 │
                       └──────────────────────────────────────────┘
```

### `packages/contracts`

Zod schemas for every shape that crosses a boundary: session configuration, provider-facing events the core exposes, the handler request and result stream, append payloads, call records. Exported as JSON Schema so non-TypeScript consumers validate against the same source. Changing a schema is a contract change and follows the rules in `docs/PROTOCOL.md`.

### `packages/core`

The library. Owns:

- **Session state machine.** `created → started → active → closing → closed`, plus `failed` and `incomplete` (ended without the provider's final events). Transitions are explicit; no transport or handler can move a session except through the core.
- **Transcript store.** Ordered user and assistant fragments with provider offsets. This is what the broker hands to handlers. It is per call, in memory during the call, persisted on close.
- **Delegation broker.** Receives a delegation id from the provider, builds a `HandlerRequest`, invokes the handler, consumes its result stream, and issues appends. Tracks every delegation id it has seen; refuses to append against an unknown one. Enforces the provider's per-append token limit in code. Owns cancellation when the session closes and discards late results from cancelled delegations.
- **Provider adapter interface.** What a speech provider must implement. The first implementation is OpenAI GPT-Live over WebSocket and WebRTC. The interface exists so a second provider is an adapter, not a rewrite.

The core has no HTTP server, no database, and no transport-specific code. It is usable in a consumer's own process.

### `packages/transports`

One adapter per way audio reaches the core:

- **webrtc**: the server receives a browser's SDP offer, creates the provider session, returns the answer. Audio flows browser to provider directly; events flow over the data channel and, when the server needs them, a server-side attach connection.
- **websocket-audio**: raw PCM or G.711 over a server WebSocket, for consumers that already have an audio stream.
- **twilio**: TwiML endpoint plus a Media Streams WebSocket. G.711 μ-law at 8 kHz forwarded without resampling. Inbound via TwiML; outbound by placing a call whose TwiML points back at the same stream endpoint.
- **sip**: the provider's incoming-call webhook, accept and reject decisions, a server-side attach for events, transfer and hangup. Requires the provider to enable SIP for the project.

Each transport is responsible for translating its own envelope and owning any audio it buffers for playback. Matching audio formats do not make two event protocols interchangeable.

### `apps/server`

Fastify. Authenticates API keys, exposes session creation, hosts the transport endpoints, forwards delegations to remote handlers, persists call records and usage, and streams session events to the console. Stateless across requests except for live sessions, which are pinned to the instance that owns their provider connection.

### `apps/console`

Vite and React. Start a browser call, watch the transcript and delegation timeline live, inspect completed calls. It is an observation and demo surface. It never holds a provider key.

### `examples/`

`handler-node` and `handler-python`: two implementations of the same sample consumer, a mock booking backend. Both must pass the contract tests in `packages/contracts`. They prove the wire contract is language-neutral and give integrators a starting point.

## Trust boundaries

Three parties, three trust levels.

**The caller** is untrusted. Everything they say is input. Transcript text is never used as an instruction to the model or to the handler; it is data the consumer interprets.

**The speech provider** is a trusted service but not a trusted decision-maker. It decides when to speak and when to ask for help. It never decides what is true or what action to take. duplexd forwards its delegation signals and returns the consumer's results; it does not let the provider reach the consumer directly.

**The consumer backend** is the authority. It owns permissions, tool execution, confirmations, memory, and business records. duplexd gives it the transcript and session context and nothing else; it gets back results and nothing else. A consumer's credentials, tool definitions, and data never pass through duplexd.

The server's API key authenticates a consumer to duplexd. It does not authorize anything on the consumer's side. Authorization for what a caller may do is the consumer's problem, decided with the consumer's own session identity, never from anything in the transcript.

## Lifecycle of one delegation

1. Provider emits a delegation event with an opaque id. The broker records it.
2. Broker snapshots the transcript and attaches the session's consumer context (an opaque blob the consumer supplied at session creation, echoed back unchanged).
3. Broker invokes the handler. In-process: a function call. Remote: HTTP POST to the consumer's endpoint with the request body; the response is a stream of result items.
4. Each result item is one of: `thinking` (silent context), `commentary` (to be spoken), `instruction` (session-wide steering), or `done`. The broker forwards each as the matching provider append, always carrying the delegation id, always within the provider's token limit.
5. On `done`, or on handler timeout, or on session close, the broker marks the delegation finished and stops reading the handler stream. A timeout produces an honest state event; it never fabricates a spoken result. Later items are not observed.

The provider may emit a second delegation before the first finishes. The broker runs them concurrently and keeps the ids separate.

## Persistence

PostgreSQL holds sessions, calls, delegations, transcripts, and usage. Records are written at session close, not streamed during the call; a crash mid-call produces an `incomplete` record from whatever the instance had, marked as such. Live session state is in the owning process, not the database. The database is not a message bus.

## What would change this

A second speech provider with a different delegation model would test whether the broker abstraction is real or GPT-Live-shaped. A consumer needing sub-second handler round trips at high concurrency would push toward a persistent bidirectional handler connection instead of HTTP per delegation. Either is an ADR, not a quiet refactor.
