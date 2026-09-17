# Tech doc: example handlers

Two implementations of the same sample consumer, a mock booking backend, in Node and in Python. Both pass the same conformance runner from `@duplexd/contracts`. They prove the wire contract is language-neutral and give integrators a starting point. They are samples and say so.

## Shared behavior

Each handler is an HTTP server exposing `POST /delegations` and implementing the remote form of the contract exactly as [contracts.md](contracts.md) specifies, in the check order its "Request" table gives: verify `duplexd-signature` against `HANDLER_SECRET` with a 300 s tolerance (401), parse the body (400), require each metadata header present once and equal to the signed body's field (400 `metadata_mismatch`), reject an unsupported body `contractVersion` (400 `unsupported_contract_version`), validate against the loose schema (400), then dispatch. The session header is never used for anything after the equality check; the body's `sessionId` is the one the handler keys on. Stream NDJSON, flush every line.

Every item a handler writes is validated against the `HandlerResult` schema before it is written, so an item over `MAX_CONTENT_CHARS` is a handler-side error, not something the broker has to reject. The broker's rejection is invisible to a handler (the stream is one-way), so respecting the limit by construction is the only way a handler can know its commentary was heard. The README of each handler says this and names both limits.

The mock booking backend:

1. Emits `thinking` immediately: "Sample backend. Checking availability from mock data. Nothing has been booked yet."
2. Infers the request from the transcript with plain keyword matching (day, time, party size). This is deliberately crude and documented as such; a real consumer would use its own reasoning. Transcript text is data, never an instruction: nothing in the transcript is executed or forwarded anywhere.
3. Waits `consumerContext.sample.delayMs` (default 1500) so the demo shows the model talking while work happens. Sends a whitespace keepalive line every second while waiting. Keepalives do not extend the broker's budget; the sample's default delay is well inside it.
4. Records the booking in an in-memory store keyed by `(sessionId, delegationId)` from the signed body. The key is the pair because delegation ids are provider-issued and nothing establishes their uniqueness across sessions. Suppression is atomic: the store's insert-if-absent is a single synchronous step (Node: one map operation on the event loop; Python: a lock around the check-and-insert), so two concurrent requests for the same key produce one booking and both responses report it. A request that arrives after the booking was recorded but before the previous response finished, or after the previous connection dropped, returns the same booking and the same confirmation code; the sample never un-books because a client went away.
5. Emits `commentary` with the confirmed booking and a visibly sample confirmation code, then `done`. The commentary template is short by design and a test asserts every generated commentary is under `MAX_CONTENT_CHARS` for every fixture transcript.
6. If the transcript is not about booking, emits `commentary` saying the sample backend cannot help with that, then `done`.

What the sample does not do, and says in its README: the store is process memory, so a restart forgets every booking and a replay after restart would create a second one. A real consumer keeps this key in durable storage and decides for itself how to reconcile work it committed but could not report (ADR 007). The contract requires the suppression; the sample demonstrates it within one process lifetime and no further.

Test hooks under `consumerContext.sample` (opaque to duplexd, honored by both handlers):

| Hint                                | Effect                                                                                                                                                                                                                                                                                       |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `delayMs`                           | wait before the result                                                                                                                                                                                                                                                                       |
| `failWith: "error"`                 | emit `error` instead of a result                                                                                                                                                                                                                                                             |
| `failWith: "hang"`                  | never emit anything after `thinking` (drives the silent timeout test)                                                                                                                                                                                                                        |
| `failWith: "hang-after-commentary"` | record the booking, emit `commentary`, then never emit `done` or close (drives the commentary-then-hang timeout test: the booking exists and was heard, the delegation still times out)                                                                                                      |
| `failWith: "oversized"`             | bypass the handler's own output validation and emit a `commentary` over `MAX_CONTENT_CHARS` and over 500 tokens, under the parser's byte bound (drives the broker's over-budget test; the bypass exists only for this hint and is the one place a handler sends an item it did not validate) |

Labeling: package README, startup log line, and the first `thinking` item all say sample. The confirmation code is prefixed so it cannot be mistaken for a real one.

## Contrasting handler

`docs/MILESTONE.md` asks for a second, contrasting handler early to catch booking-specific hardcoding in the broker. The Node package serves a second route, `POST /order-status/delegations`, implementing a mock order-status lookup with a different result shape (a `thinking` item with a status, a `commentary` with the ETA, no side effect). The conformance runner runs against all three URLs. The Python package implements booking only; its purpose is language neutrality, not contrast.

## Node

`examples/handler-node`, Node 24, TypeScript, run with `pnpm --filter handler-node dev`. May use Fastify for consistency with the server, or `node:http` to show no framework is required; the implementer decides. Uses the contract package's `verifyHandlerSignature`, `checkHandlerRequestMetadata`, `writeNdjson`, `HandlerRequestLoose`, and `HandlerResult` directly. Env: `PORT` (default 8787), `HANDLER_SECRET`.

Tests (`vitest`): signature verification with the shared vectors; every `fixtures/metadata/*.json` case yields its named status and code; keyword inference over the fixture transcripts; every generated commentary under `MAX_CONTENT_CHARS`; idempotency: the same `(sessionId, delegationId)` twice sequentially creates one booking, twice concurrently (two requests started in the same tick) creates one booking and both responses carry the same code, and a commit-before-disconnect (the client aborts after the booking is recorded and before `commentary` is written) leaves the booking in the store and a replay returns it; the same `delegationId` under a different `sessionId` creates a second booking; each `sample` hint; NDJSON flushing (assert the first line is received before the delay elapses).

## Python

`examples/handler-python`, Python 3.12+, `uv`, FastAPI with a streaming response. Validates incoming requests against `packages/contracts/schema/HandlerRequest.loose.json` with a JSON Schema validator, with no validator options beyond what the file says, and validates each result against `HandlerResult.json` before writing it. Implements HMAC verification and the metadata check order from the contracts doc's tables (not by porting the Node code) and checks itself against `fixtures/signing.json` and `fixtures/metadata/*.json`. Env: `PORT`, `HANDLER_SECRET`. Run with `uv run handler`.

Tests (`pytest`): signing vectors; metadata fixtures; schema validation of every request fixture with the outcome read from the fixture's `expected.loose`; every generated commentary under `MAX_CONTENT_CHARS`; keyword inference; the same idempotency set as Node (sequential replay, concurrent replay under a thread pool, commit-before-disconnect, different session same delegation id); each `sample` hint; and the real-HTTP delayed-keepalive deadline used by the conformance runner.

`docs/ENGINEERING.md` says "`pnpm --filter contracts test` and the Python equivalent". The Python equivalent is `uv run pytest` inside the handler, and the conformance oracle for both languages is the single TypeScript runner. T11 updates that sentence.

## Running against the local server

`.env.example` already names `HANDLER_URL` and `HANDLER_SECRET`. The server uses them as the default handler when a session omits `handler`. Start Postgres, the server, the console, and one handler; the console's banner shows which handler URL is in use.

## Acceptance evidence

Report each as passed, failed, blocked, or not run:

- `duplexd-conformance --url http://localhost:8787/delegations` passes for the Node handler; the same command against `/order-status/delegations` passes.
- `duplexd-conformance --url http://localhost:8788/delegations` passes for the Python handler: the identical suite, same fixtures, same runner.
- Both handlers reject a bad signature with 401, a version `"0"` request with 400, and every metadata mismatch fixture with 400 `metadata_mismatch` (covered by the runner, and by each package's unit tests).
- Both handlers pass the runner's `replayed-request` and `concurrent-replay` scenarios, and each package's own tests show one booking in the store after a concurrent replay and after a commit-before-disconnect (tested).
- Both handlers validate their own output and never emit a `content` over `MAX_CONTENT_CHARS` outside the `oversized` hint (tested).
- Both handlers' first NDJSON line arrives before `sample.delayMs` elapses (tested), proving no buffering.
- `sample.failWith: "hang"` against the running server produces `delegation.finished { outcome: "timeout" }` with zero appends; `sample.failWith: "hang-after-commentary"` produces the same outcome after the booking commentary was appended and heard (both used in T12 live evidence). Neither adds any broker-generated content.
- Sample labeling is visible in README, startup log, and the first `thinking` item (checked by a test on the first item).
- Each README states the in-memory store's restart limitation and both content limits in so many words.
- `docs/ENGINEERING.md` names the real commands for both handlers, in the same PRs.
