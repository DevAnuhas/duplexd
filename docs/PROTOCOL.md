# Protocol

The wire contract between duplexd and a consumer backend, and the provider events duplexd exposes. `packages/contracts` is the executable form of this document; when they disagree, fix whichever is wrong and add a test.

Field names and shapes below are the intended design. They are not final until `packages/contracts` exists and its tests pass. Treat this file as the specification the contracts package implements, not as verified API.

## Session creation

A consumer creates a session by calling the server (or the core, in-process) with:

```
SessionConfig {
  provider: "openai-gpt-live"            // the only value in milestone 1
  instructions: string                    // conversation style and delegation policy; short
  voice?: string
  audio?: { format: ... }                 // transport-dependent; omitted for WebRTC and SIP
  consumerContext?: JSON                  // opaque; echoed back in every HandlerRequest
  handler: { type: "in-process" } | { type: "remote", url: string, auth: ... }
  handlerTimeoutMs?: number               // default to be decided in contracts
}
```

`instructions` are for the speech model only: tone, pacing, when to ask for help. Reasoning instructions, tool schemas, and business rules belong in the consumer's own handler and never appear here.

The provider's own session id is returned and used unchanged everywhere after.

## Events the core exposes

A normalized subset of provider events, so consumers and the console do not depend on one provider's naming:

- `session.started`, `session.closing`, `session.closed { usage }`, `session.failed { reason }`, `session.incomplete { reason }`
- `transcript.user.delta { text, offsetMs }`, `transcript.assistant.delta { text, offsetMs }`
- `delegation.created { delegationId, offsetMs }`, `delegation.finished { delegationId, outcome: "done" | "timeout" | "cancelled" | "error" }`
- `append.sent { delegationId | null, kind, tokens }`
- `transport.dtmf { digit }` (telephony only)

Provider-specific events pass through on a separate `provider.raw` channel for debugging. Nothing in the contract depends on them.

## Handler request

Sent once per delegation.

```
HandlerRequest {
  sessionId: string
  delegationId: string
  offsetMs: number
  transcript: Array<{ role: "user" | "assistant", text: string, offsetMs: number }>
  consumerContext?: JSON
  priorDelegations: Array<{ delegationId, outcome }>
}
```

The request contains no task text. The consumer infers what the caller wants from the transcript and its own state. This is deliberate and matches how the provider works: the speech model signals that it needs help, not what for.

## Handler result stream

The handler returns an ordered stream of items. In-process: an async iterable. Remote: a streamed HTTP response body, one JSON object per line, or an SSE stream; the contracts package will fix exactly one and record it in an ADR.

```
HandlerResult =
  | { kind: "thinking",     content: string }   // silent context for the model
  | { kind: "commentary",   content: string }   // the model paraphrases this aloud
  | { kind: "instruction",  content: string }   // session-wide steering, delegationId is null on the wire
  | { kind: "done" }
  | { kind: "error",        message: string }   // surfaced as an honest state, never spoken
```

Rules the broker enforces regardless of what the handler sends:

- Each `content` is limited to the provider's per-append budget (currently 500 tokens for GPT-Live). Oversized items are rejected with an error event, not truncated silently.
- `commentary` should only carry results the consumer has confirmed. Announcing a booking before it exists is the consumer's bug, but the contract documents the expectation.
- Items after `done` or after the broker has finished the delegation are dropped and counted.
- A stream that ends without `done` is treated as `done`.
- A handler that does not respond within `handlerTimeoutMs` produces `delegation.finished { outcome: "timeout" }`. Nothing is spoken on the consumer's behalf.

## Remote handler authentication

The server signs each `HandlerRequest` with a per-session secret issued at creation and sends it in a header. The consumer verifies it. The consumer's own API key for duplexd is never forwarded. Details in `packages/contracts` once decided.

## Versioning

The contract carries a version. Breaking a shape means bumping it and shipping a migration note in `docs/decisions/`. Example handlers pin the version they implement. A server refuses a handler declaring a version it cannot speak.

## Provider mapping (OpenAI GPT-Live)

For reference, the provider-side mapping the core implements. Consumers do not need this.

| Contract | Provider |
| --- | --- |
| session create | `session.start` over WebSocket, or `POST /v1/live/sessions` for WebRTC and SIP accept |
| `delegation.created` | `session.delegation.created` with `delegation.target: "client"` |
| `thinking` | `session.thinking.append { delegation_id }` |
| `commentary` | `session.commentary.append { delegation_id }` |
| `instruction` | `session.instructions.append { delegation_id: null }` |
| `session.closed` | `session.closed { usage }` after `session.close` |
| transcript deltas | `session.input_transcript.delta`, `session.output_transcript.delta` |

The session is created with `delegation.type: "client"`. Delegation mode cannot change after start; a consumer wanting the provider's managed Responses backend is outside this product's scope.
