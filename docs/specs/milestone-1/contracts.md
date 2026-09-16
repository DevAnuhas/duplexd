# Tech doc: packages/contracts

The single source of truth for every wire shape. `AGENTS.md`: code that disagrees with the contract is wrong, not the contract. This package ships Zod schemas, JSON Schema exports, fixtures, a reference NDJSON parser and writer, a request signing helper, and a handler conformance runner that any handler URL can be tested against.

Package name `@duplexd/contracts`. No runtime dependency on core, server, or any provider SDK. Node-only runtime dependencies are confined to the conformance entry point; schemas, signing, metadata, and the NDJSON parser are importable in a browser. Build, spike, and test tooling may use Node APIs.

## Versioning

`CONTRACT_VERSION = "1"`. A string, compared for equality; there is no range semantics in milestone 1. The server declares the version it speaks: every `HandlerRequest` carries it in the body, and the server repeats it in the `duplexd-contract-version` header. The body is authoritative; the header must equal it (see "Remote form wire format"). A handler that cannot speak the declared version returns 400 with problem code `unsupported_contract_version`. The handler declares nothing on the wire, so the direction is always server declares, handler refuses. Breaking a shape bumps the version and ships a migration note in `docs/decisions/`.

## Shapes

Written as TypeScript-ish; the Zod schemas are the executable form. `JsonValue` is any JSON value.

### SessionConfig

```
SessionConfig {
  provider: "openai-gpt-live"
  instructions: string            // 1..4000 chars; speech-model style and delegation policy only
  voice?: string
  audio?: { format: "pcm16" | "g711_ulaw" | "g711_alaw", sampleRateHz?: 8000 | 16000 | 24000 }
                                   // omitted for WebRTC; present for WebSocket audio (not used in milestone 1 except the live test)
  consumerContext?: JsonValue     // opaque; serialized size ≤ 16 KiB; echoed in every HandlerRequest; never persisted
  handler:
    | { type: "in-process" }
    | { type: "remote", url: string, auth: { type: "hmac-sha256", secret: string /* ≥ 16 chars */ } }
  handlerTimeoutMs?: number       // integer 1000..120000, default 30000 (ADR 007)
}
```

`handler.url` must match this `pattern` exactly:

```
^(?:https://(?:\[[0-9a-fA-F:]+\]|[^\s@/?#:[\]]+)(?::[0-9]+)?(?:[/?][^\s#]*)?|http://(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?(?:[/?][^\s#]*)?)$
```

It permits `https:`, or `http:` only for loopback, and rejects userinfo, fragments, whitespace, and malformed authorities. Zod uses `.regex()`, so JSON Schema carries the same rule. The response path relies on TLS because request signing does not authenticate the response.

`SessionConfig.consumerContext` and the derived `SessionCreateRequest.consumerContext` enforce their 16 KiB serialized UTF-8 bound in native Zod. This shared-field constraint has no standard JSON Schema representation, so it is the one explicitly documented exception to cross-validator equivalence; neither exported schema invents a vendor keyword. The TypeScript creation endpoint always runs native Zod. `HandlerRequest.consumerContext` is an unchecked echo of that already-validated value.

`handler.auth.secret` is marked in the schema metadata as secret so the server's redaction helper strips it from logs and records. The `in-process` variant is a marker for core consumers; the server rejects it (there is no function to call).

`handler` is required in `SessionConfig`. The server's create route accepts a derived shape, `SessionCreateRequest`, which is `SessionConfig` with `handler` optional, because in the demo the server fills in a default handler from its environment and the console must never see the secret. `SessionCreateRequest` is exported from this package (derived from the same Zod source, so the two cannot drift) and is a server API shape, not a handler-facing one.

### Core events

Every event has `type`, `sessionId`, `seq` (monotonic integer per session, from 1), and `at` (ISO-8601). Discriminated on `type`:

| type                         | payload                                                                                                                                                                                            |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session.started`            | `{}`                                                                                                                                                                                               |
| `session.closing`            | `{}`                                                                                                                                                                                               |
| `session.closed`             | `{ usage: Usage }`                                                                                                                                                                                 |
| `session.failed`             | `{ reason: string }`                                                                                                                                                                               |
| `session.incomplete`         | `{ reason: "provider_disconnected" \| "provider_final_event_missing" \| "process_shutdown" \| "instance_lost" }`                                                                                   |
| `transcript.user.delta`      | `{ text: string, offsetMs: number }`                                                                                                                                                               |
| `transcript.assistant.delta` | `{ text: string, offsetMs: number }`                                                                                                                                                               |
| `delegation.created`         | `{ delegationId: string, offsetMs: number }`                                                                                                                                                       |
| `delegation.finished`        | `{ delegationId: string, outcome: "done" \| "timeout" \| "cancelled" \| "error", error?: string }`                                                                                                 |
| `append.sent`                | `{ delegationId: string \| null, kind: AppendKind, tokens: number }`                                                                                                                               |
| `append.rejected`            | `{ delegationId: string \| null, kind: AppendKind, reason: "over_budget" \| "unknown_delegation" \| "delegation_finished" \| "provider_error", tokens?: number, chars?: number, detail?: string }` |
| `transport.dtmf`             | `{ digit: string }` (schema only; no producer in milestone 1)                                                                                                                                      |
| `provider.raw`               | `{ event: JsonValue }` (debug channel; excluded from streams unless requested)                                                                                                                     |

`AppendKind = "thinking" | "commentary" | "instruction"`.

Every event carries `sessionId`, so no event can describe a session that never got a provider id. A provider that rejects session creation before allocating an id produces no core event at all; the caller gets a thrown error and nothing else (see [core.md](core.md) and [server-api.md](server-api.md)). `session.failed` is reserved for a session that has an id and fails before `session.started`.

`session.incomplete { reason: "instance_lost" }` is written by the server's boot-time sweeper for a session whose owning process died without reaching a terminal state (see [server-api.md](server-api.md), "Persistence"). It is the one event the core never emits; the server appends it to the persisted log so a replay terminates.

`delegation.finished` carries no late-item count. The broker stops reading the handler stream when it decides an outcome; anything the handler produces afterwards is never read and is not observable. The protocol therefore describes those items as "not read" rather than implying that the broker continues consuming and counting them.

`append.rejected` is an addition to `docs/PROTOCOL.md`, which says an over-budget append is "rejected with an error event" without naming it. T02 adds it to the protocol document in the same PR.

`Usage = { seconds: number, raw: JsonValue }`. Only `seconds` is verified; the raw provider object is preserved.

### HandlerRequest

```
HandlerRequest {
  contractVersion: "1"
  sessionId: string
  delegationId: string
  offsetMs: number
  transcript: Array<{ role: "user" | "assistant", text: string, offsetMs: number }>
  consumerContext?: JsonValue
  priorDelegations: Array<{ delegationId: string, outcome: "done" | "timeout" | "cancelled" | "error" | "running" }>
}
```

`running` is an addition to the protocol's `priorDelegations.outcome` so a handler can see a concurrent delegation still in flight. No task text, ever.

Two Zod schemas exist for this shape, generated from one source, and are exported under distinct names:

- `HandlerRequestStrict`: what the broker validates _outgoing_ requests against. Unknown keys are rejected at every object level, so the broker can never leak a field the contract does not name.
- `HandlerRequestLoose`: what handlers validate _incoming_ requests against. Unknown keys are tolerated at every object level, so a version-1 handler survives additive changes. Known keys are validated identically to the strict schema.

Both are exported to JSON Schema under the same names (see "JSON Schema export"). A fixture that is valid under one and invalid under the other says so explicitly; "identical to Zod" always means identical to the named variant.

### HandlerResult

```
HandlerResult =
  | { kind: "thinking",    content: string }   // ≤ MAX_CONTENT_CHARS
  | { kind: "commentary",  content: string }   // ≤ MAX_CONTENT_CHARS
  | { kind: "instruction", content: string }   // ≤ MAX_CONTENT_CHARS
  | { kind: "done" }
  | { kind: "error",       message: string }
```

Unknown `kind` fails validation; the broker finishes the delegation with `outcome: "error"`. Extra fields on a known kind are tolerated.

`content` has two limits, and the reason there are two is that the handler can see one of them and not the other:

- `MAX_CONTENT_CHARS = 500`, enforced by the schema. A handler that validates its own output (both examples do) rejects an oversized item before it is sent, in any language, without a tokenizer. 500 characters is about eighty words, which is the shape of a spoken paraphrase. For natural-language text it sits under the token budget; it is not a hard guarantee for arbitrary Unicode, which is why the second limit stays.
- `APPEND_TOKEN_BUDGET = 500`, the provider's per-append budget, enforced by the broker with a tokenizer whose encoding is unverified (T05 checks it).

The broker treats both the same way: an item over either limit is `append.rejected { reason: "over_budget" }` with `chars` or `tokens` set, the item is never truncated, and the stream continues. The result stream is one-way (ADR 006), so the handler is not told; the rejection is visible in the event stream and the call record, and `docs/PROTOCOL.md` tells consumers to keep commentary short and names both limits. A back-channel to the handler was considered and rejected for milestone 1 as a second protocol.

### Constants

`APPEND_TOKEN_BUDGET = 500` (verified, `live-delegation`). `MAX_CONTENT_CHARS = 500`. `DEFAULT_HANDLER_TIMEOUT_MS = 30000`, `MIN_HANDLER_TIMEOUT_MS = 1000`, `MAX_HANDLER_TIMEOUT_MS = 120000` (ADR 007). `SIGNATURE_TOLERANCE_SECONDS = 300` (ADR 008). `MAX_NDJSON_LINE_BYTES = 65536` (ADR 006 consequences; the reasoning is under "Remote form wire format").

### CallRecord

What the server persists and returns. No secrets, no `consumerContext`.

```
CallRecord {
  contractVersion: "1"
  sessionId: string                       // provider session id, unchanged; the primary key
  provider: "openai-gpt-live"
  state: "closed" | "failed" | "incomplete"
  reason?: string
  createdAt, startedAt?, endedAt: ISO-8601
  usage?: Usage                            // present only when state is "closed"
  instructions: string
  voice?: string
  handler: { type: "remote", url: string } | { type: "in-process" }
  transcript: Array<{ role, text, offsetMs }>
  delegations: Array<{ delegationId, offsetMs, outcome, createdAt, finishedAt?, appends: number }>
  appends: Array<{ seq, delegationId: string | null, kind, tokens, at }>
  rejectedAppends: Array<{ seq, delegationId, kind, reason, at }>
}
```

A `failed` record exists only for a session that received a provider id. A creation attempt the provider rejected before allocating an id leaves no record, because the record's primary key is that id and `AGENTS.md` forbids minting one. An `incomplete { reason: "instance_lost" }` record has `endedAt` set to the sweep time and an empty transcript, since the owning process took its memory with it.

## Remote form wire format

Per ADR 006 and ADR 008.

### Request

`POST <handler.url>` with `Content-Type: application/json`, body = `HandlerRequest` JSON (validated by the broker against `HandlerRequestStrict`; canonical field order not required), headers:

| Header                     | Value                                                                          |
| -------------------------- | ------------------------------------------------------------------------------ |
| `duplexd-signature`        | `t=<unix seconds>,v1=<hex>` where `v1 = HMAC-SHA256(secret, "<t>." + rawBody)` |
| `duplexd-contract-version` | equal to the body's `contractVersion`                                          |
| `duplexd-session-id`       | equal to the body's `sessionId`                                                |

The signed body is authoritative. The two metadata headers exist for logs, traces, and proxies that cannot read a body; nothing in a handler acts on them before the equality check below, and they carry no authority of their own. A handler checks in this order and stops at the first failure, before any dispatch or side effect:

| Step | Check                                                                                                                        | Failure                                                        |
| ---- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 1    | Signature over the raw body bytes verifies in constant time; `t` within `SIGNATURE_TOLERANCE_SECONDS` of the handler's clock | `401`, `code: "invalid_signature"` or `"stale_timestamp"`      |
| 2    | Body parses as JSON                                                                                                          | `400`, `code: "malformed_body"`                                |
| 3    | Each metadata header is present exactly once and equals the body field                                                       | `400`, `code: "metadata_mismatch"`, `detail` naming the header |
| 4    | Body `contractVersion` is one the handler speaks                                                                             | `400`, `code: "unsupported_contract_version"`                  |
| 5    | Body validates against `HandlerRequestLoose`                                                                                 | `400`, `code: "invalid_request"`                               |

Signature first because everything unsigned, headers included, is untrusted until it passes. All rejections are `application/problem+json` with a `code` field. A handler never uses the session header for authorization or as an idempotency key; it uses the body's `sessionId`.

Transport: the URL rule from `SessionConfig` applies, and the broker's client never follows a redirect (`fetch` with `redirect: "error"`); any 3xx is a delegation error with `error: "redirect_refused"`. Certificate verification is the runtime default and is not configurable off.

### Response

`200` with `Content-Type: application/x-ndjson`, one `HandlerResult` per line, `\n` terminated (CRLF tolerated), whitespace-only lines ignored as keepalives, ends on `done` or on a clean body end. Any other status before the first byte is a delegation error. A body read that fails before a clean end (reset, abort, malformed line, oversized line) is a delegation error, never `done`.

Keepalives keep an idle proxy from closing the connection. They do not extend `handlerTimeoutMs`: the budget is one wall clock from dispatch to `done` regardless of how many keepalives arrive (ADR 007). A handler that needs longer than the budget needs a bigger budget in `SessionConfig`, not more keepalives.

Byte bound: the parser accumulates at most `MAX_NDJSON_LINE_BYTES` for any single line, counting partial lines across chunks and counting whitespace keepalive lines the same as items. The moment the buffer would exceed the bound the parser throws `NdjsonLineTooLong`, before waiting for a newline, and the broker aborts the request and finishes the delegation with `outcome: "error"`, `error: "ndjson_line_too_long"`. The bound exists because the token budget is checked only once a line is complete, so it cannot bound memory on its own; the wall-clock timeout is not a byte bound either. 64 KiB holds any item that could pass either content limit many times over, so the over-budget path is still reachable: the `oversized` fixture is over both content limits and under the byte bound, and a separate `line-too-long` fixture crosses the byte bound.

The package exports:

- `signHandlerRequest(secret, body: string, now?)` and async `verifyHandlerSignature(secret, header, body, opts?)` use global WebCrypto `crypto.subtle`; `subtle.verify` supplies the constant-time comparison. Signing has no Node-only entry point.
- `checkHandlerRequestMetadata(headers, body)` returning the step-3 and step-4 outcome, so the Node example handler and the reference handler share one implementation of the order above. The Python handler implements the same table from this document.
- `parseNdjson<T>(stream: ReadableStream<Uint8Array>, parseLine: (json: unknown) => T, opts?: { maxLineBytes? }): AsyncIterable<T>` handling partial chunks, CRLF, keepalive lines, a final line without `\n`, and the byte bound. It is a pull-based async generator: nothing is parsed ahead of the consumer. It is generic over the line type and uses only web-standard APIs, so the same parser reads `HandlerResult` lines in the server and `CoreEvent` lines in the console.
- `writeNdjson(item): string`.

## JSON Schema export

`pnpm --filter @duplexd/contracts build` uses Zod 4 native `toJSONSchema` and writes committed draft-2020-12 files under `packages/contracts/schema/`: `SessionConfig.json`, `SessionCreateRequest.json`, `CoreEvent.json`, `HandlerRequest.strict.json`, `HandlerRequest.loose.json`, `HandlerResult.json`, `CallRecord.json`, plus generated `constants.json`. The committed compatibility spike covers recursive JSON, CoreEvent, nested strict/loose objects, and regex plus max length; all passed, so no schema is hand-authored.

Each JSON Schema is compared with its named Zod variant over fixtures, with only the documented SessionConfig/SessionCreateRequest consumer-context byte-bound exception. CI generates into a separate directory, compares the complete file set and bytes, and fails if build changes or adds a committed artifact. The Python handler uses `HandlerRequest.loose.json`, `HandlerResult.json`, and `constants.json`.

## Fixtures

`fixtures/` holds JSON files shared across languages. Every request fixture carries an `expected` block naming the outcome under each variant, so a test in any language reads the expectation rather than assuming it:

```
{ "expected": { "strict": "valid" | "invalid", "loose": "valid" | "invalid" }, "request": { ... } }
```

- `requests/*.json`: valid and invalid `HandlerRequest` examples, including the booking transcript, the contrasting order-status transcript, an extra top-level field (`strict: invalid`, `loose: valid`), an extra nested field inside a transcript fragment (same split), a missing required field (invalid under both), and a wrong-typed `offsetMs` (invalid under both).
- `results/*.ndjson`: valid streams, a stream with keepalives, a stream ending without `done`, an unknown kind, an `oversized` commentary (over `MAX_CONTENT_CHARS` and over 500 tokens, under `MAX_NDJSON_LINE_BYTES`), a commentary at exactly `MAX_CONTENT_CHARS` (valid), a `line-too-long` stream (one line over the byte bound, split across chunks in the parser test), and an oversized whitespace keepalive line.
- `signing.json`: test vectors `{ secret, timestamp, body, header }`, plus tampered variants.
- `metadata/*.json`: a correctly signed request with, in turn, the session header changed, the version header changed, the session header duplicated, the version header missing, and the body `sessionId` changed (which breaks the signature and must fail at step 1, not step 3). Each names its expected status and `code`.
- `conformance/*.json`: scenarios for the runner (below).

Sample handlers read hints under `consumerContext.sample` (`delayMs`, `failWith: "error" | "hang" | "hang-after-commentary" | "oversized"`). Those hints are consumer context, opaque to duplexd, and are how tests force a delay past the timeout without touching the broker.

## Conformance runner

A CLI, `duplexd-conformance --url <handler url> --secret <secret> [--scenario name]`, exit code 0 on pass. It is the one oracle both example handlers run against; "identical suite" in `docs/MILESTONE.md` means one runner, two URLs. Scenarios:

| Scenario                    | Sends                                                               | Expects                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `booking-request`           | booking transcript                                                  | 200, NDJSON, every line validates (including `MAX_CONTENT_CHARS`), last item `done`                                                 |
| `order-status-request`      | order-status transcript                                             | same (a booking handler may answer with a `commentary` declining, or just `done`)                                                   |
| `empty-transcript`          | zero fragments                                                      | 200, valid stream                                                                                                                   |
| `unknown-fields`            | request with an extra top-level field and an extra nested field     | 200, valid stream (the loose schema tolerates both)                                                                                 |
| `prior-delegations`         | two prior entries incl. `running`                                   | 200, valid stream                                                                                                                   |
| `bad-signature`             | wrong secret                                                        | 401, `code: "invalid_signature"`, no stream                                                                                         |
| `stale-timestamp`           | `t` 10 minutes old                                                  | 401, `code: "stale_timestamp"`                                                                                                      |
| `unsupported-version`       | `contractVersion: "0"` in the body and the header, correctly signed | 400, `code: "unsupported_contract_version"`                                                                                         |
| `metadata-mismatch-session` | valid signed body, session header set to another id                 | 400, `code: "metadata_mismatch"`                                                                                                    |
| `metadata-mismatch-version` | valid signed body, version header `"0"`                             | 400, `code: "metadata_mismatch"` (mismatch outranks unsupported: the header is not trusted)                                         |
| `metadata-duplicate-header` | session header sent twice                                           | 400, `code: "metadata_mismatch"`                                                                                                    |
| `replayed-request`          | the `booking-request` bytes and headers sent twice, sequentially    | both 200 with valid streams; the second stream's `commentary` items equal the first's                                               |
| `concurrent-replay`         | the same request sent twice at once                                 | both 200 with valid streams; the `commentary` items of both are equal                                                               |
| `keepalive-under-delay`     | `sample.delayMs: 3000`                                              | deadline starts before dispatch and includes response headers; a complete keepalive or item arrives within 2 s, then a valid stream |

The replay scenarios are the language-neutral half of idempotency: the runner can see that a duplicate produces the same reported result, which is what the model would hear. It cannot see a side effect, so each example handler's own tests assert that one booking exists after a concurrent replay and after a commit-before-disconnect (see [example-handlers.md](example-handlers.md)). What remains unprovable by the contract is a consumer's durable store, and the contract says so rather than promising universal replay safety.

Read boundaries do not prove streaming: Web Streams reports final `done` separately even for a buffered response. Only `keepalive-under-delay` is a buffering oracle, because it measures real HTTP elapsed time against a deliberate delay. Scenarios without that delay carry no timing assertion.

## Tests

`pnpm --filter @duplexd/contracts test`: schema round-trips over every fixture under the named variant, JSON Schema equivalence over every fixture per variant, `SessionCreateRequest` accepts a body without `handler` and `SessionConfig` rejects it, signing vectors and tampered variants, metadata fixtures through `checkHandlerRequestMetadata`, the `SessionConfig` URL rule (`https://example.com` valid, `http://localhost:8787` valid, `http://example.com` invalid, `http://[::1]:8787` valid), `MAX_CONTENT_CHARS` at the boundary, NDJSON parser edge cases including the byte bound crossed mid-chunk and the oversized keepalive, the parser instantiated over `CoreEvent` lines, and the runner executed against an in-package reference handler (a tiny Node HTTP server that echoes the fixtures and implements the check order above) so the runner itself is tested.

## Acceptance evidence

Report each as passed, failed, blocked, or not run:

- `pnpm --filter @duplexd/contracts lint`, `typecheck`, `test`, `build` pass from a clean clone.
- `schema/*.json` exists after build; `HandlerRequest.loose.json` validates every request fixture identically to `HandlerRequestLoose` and `HandlerRequest.strict.json` identically to `HandlerRequestStrict`, reading `expected` from each fixture (tested).
- The signing vectors in `fixtures/signing.json` verify with the WebCrypto helper (tested) and are the vectors the Python handler uses (T11 reports separately).
- Every `fixtures/metadata/*.json` case produces its named status and `code` from the reference handler (tested).
- `SessionConfig` rejects a non-loopback `http:` handler URL and accepts loopback `http:` and any `https:` (tested).
- A `content` of `MAX_CONTENT_CHARS + 1` characters fails `HandlerResult` validation in Zod and in the exported JSON Schema; exactly `MAX_CONTENT_CHARS` passes (tested).
- `parseNdjson` throws `NdjsonLineTooLong` on a line crossing `MAX_NDJSON_LINE_BYTES` across chunks and on an oversized whitespace line, and still passes the valid chunk and CRLF fixtures (tested).
- The conformance runner passes against the in-package reference handler, including both replay scenarios, and fails against a deliberately buffering handler (tested).
- ADRs 006, 007, 008 are `accepted` and `docs/PROTOCOL.md` matches the shipped shapes, including `append.rejected`, `priorDelegations.outcome: "running"`, the header-equality rule, the URL rule, stopping reads at completion, the versioning direction, the keepalive rule, both content limits, and the consumer-supplied secret.
- Contract version is `"1"` from the first commit and a `"0"` request is refused by the reference handler (tested).
