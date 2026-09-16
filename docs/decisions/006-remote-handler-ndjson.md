# 006: Remote handler results stream as newline-delimited JSON

Status: proposed
Date: 2026-09-16

## Context

ADR 003 fixes one contract with two delivery forms and defers the remote form's streaming encoding. The in-process form is an async iterable of `HandlerResult` items. The remote form must carry the same ordered items over one HTTP response, from a handler written in any language, through whatever proxies sit between the consumer and duplexd, with no library beyond a JSON encoder and an HTTP server that can flush.

The consumer of the stream is duplexd's server, never a browser. The stream lives at most as long as `handlerTimeoutMs` (ADR 007, up to two minutes), has no reconnection semantics, and carries no event types beyond what each item's `kind` already says.

## Decision

The remote handler responds to the `HandlerRequest` POST with HTTP 200, `Content-Type: application/x-ndjson`, and a chunked body of one JSON-encoded `HandlerResult` per line, terminated by `\n`. Lines that are empty or whitespace-only are keepalives and are ignored. The stream ends on `{"kind":"done"}` or on a clean body end, which the broker treats as `done`. Any non-200 status before the first byte is `delegation.finished { outcome: "error" }`.

A body read that fails before a clean end is not body end. A reset connection, an aborted read, malformed JSON on a line, or a line that exceeds the parser's byte bound finishes the delegation with `outcome: "error"`. Only a clean end of body is `done`.

Handlers must flush after every line. The contract package ships a reference parser, a reference writer, and NDJSON fixtures the contract test runner replays against any handler URL.

## Alternatives

**Server-sent events.** Rejected: SSE's `event:`, `id:`, `retry:` fields and reconnection model buy nothing here, since the item `kind` is already in the payload and a delegation is never resumed. SSE needs a parser in every language; NDJSON is `json.loads` per line. `EventSource` cannot POST a body, so the browser convenience that justifies SSE does not apply to a server-to-server call.

**WebSocket or gRPC per handler.** Deferred in ADR 003. Reopen if measured latency or concurrency demands a persistent connection.

**Buffered JSON array response.** Rejected: it defeats the point. `thinking` items must reach the model while the handler is still working.

## Consequences

Any HTTP stack that buffers responses breaks the contract silently; the contract test runner asserts that the first line arrives before the stream ends, so buffering is caught in tests, not in production.

Keepalive lines are the only idle-proxy defense. A handler that does nothing for longer than an intermediate proxy's idle timeout must emit them.

The provider's per-append token budget is not a memory bound: it is checked only once a line is complete. The reference parser therefore bounds a single line in bytes, keepalives and partial lines included, with the constant living in `packages/contracts`. That bound is a transport resource limit and is independent of the token budget.

This amends ADR 003. Server-to-console streaming is outside this record's scope; the server uses the same encoding and the same reference parser there, because once the console reads with `fetch` rather than `EventSource`, SSE's one browser advantage is gone and a second encoding would exist for no reason.
