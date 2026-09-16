# Protocol

The wire contract between duplexd and consumer backends, and the provider events duplexd exposes. `packages/contracts` is executable and authoritative; this document explains the same shapes and rules.

## Versioning

`CONTRACT_VERSION = "1"`. The server declares this version in every handler request body and repeats it in `duplexd-contract-version`. A handler that cannot speak the body version returns HTTP 400 with `code: "unsupported_contract_version"`. Breaking changes bump the version and add a migration note; additive changes keep version 1, which is why incoming handler requests use the loose schema.

## Session creation

`SessionConfig` requires:

- `provider: "openai-gpt-live"`;
- `instructions` from 1 to 4000 characters;
- optional `voice`;
- optional `audio { format: "pcm16" | "g711_ulaw" | "g711_alaw", sampleRateHz?: 8000 | 16000 | 24000 }`;
- optional JSON `consumerContext`, serialized to at most 16 KiB;
- `handler`, either `{ type: "in-process" }` or `{ type: "remote", url, auth: { type: "hmac-sha256", secret } }`, where the secret has at least 16 characters;
- optional integer `handlerTimeoutMs` from 1000 to 120000, default 30000.

The server create route accepts `SessionCreateRequest`, derived from the same schema with only `handler` optional. The server may fill its local default from the environment; the console never receives that secret.

Both session shapes and every contract-owned nested object in them are strict: unknown fields are rejected. The serialized-byte consumer-context bound is enforced by the Zod runtime; it is the one constraint that portable JSON Schema cannot express.

The provider's session id is returned and preserved unchanged. If the provider rejects creation before allocating an id, the caller receives an error and duplexd creates no session, event, or record.

## Core events

Every event has `type`, `sessionId`, integer `seq` starting at 1, ISO-8601 `at`, and a strict `payload`.

- `session.started`, `session.closing`
- `session.closed { usage }`
- `session.failed { reason }`
- `session.incomplete { reason }`, where reason is `provider_disconnected`, `provider_final_event_missing`, `process_shutdown`, or `instance_lost`
- `transcript.user.delta { text, offsetMs }`, `transcript.assistant.delta { text, offsetMs }`
- `delegation.created { delegationId, offsetMs }`
- `delegation.finished { delegationId, outcome, error? }`, where outcome is `done`, `timeout`, `cancelled`, or `error`
- `append.sent { delegationId: string | null, kind, tokens }`
- `append.rejected { delegationId: string | null, kind, reason, tokens?, chars?, detail? }`
- `transport.dtmf { digit }`
- `provider.raw { event }`

`AppendKind` is `thinking | commentary | instruction`. `append.rejected.reason` is `over_budget | unknown_delegation | delegation_finished | provider_error`. `session.incomplete { reason: "instance_lost" }` is appended by the server sweeper, never emitted by core.

## Handler request

The server validates outgoing requests with `HandlerRequestStrict`; unknown keys are rejected at every contract-owned object level. Handlers validate incoming requests with `HandlerRequestLoose`; unknown keys are tolerated at every such level for additive compatibility. Known fields are identical:

```text
HandlerRequest {
  contractVersion: "1"
  sessionId: string
  delegationId: string
  offsetMs: non-negative integer
  transcript: Array<{ role: "user" | "assistant", text: string, offsetMs: non-negative integer }>
  consumerContext?: JSON
  priorDelegations: Array<{
    delegationId: string
    outcome: "done" | "timeout" | "cancelled" | "error" | "running"
  }>
}
```

The request contains no task text. The consumer reconstructs intent from transcript and its own state.

## Handler result stream

Remote handlers answer with HTTP 200, `Content-Type: application/x-ndjson`, one `HandlerResult` JSON object per LF-terminated line. CRLF is tolerated. Whitespace-only lines are keepalives and are not results. A clean end without `done` is treated as done; reset, abort, malformed JSON, invalid result, or oversized line is an error.

```text
HandlerResult =
  | { kind: "thinking", content: string }
  | { kind: "commentary", content: string }
  | { kind: "instruction", content: string }
  | { kind: "done" }
  | { kind: "error", message: string }
```

Each content string is limited twice. `MAX_CONTENT_CHARS = 500` is enforced by the handler-result schema; `APPEND_TOKEN_BUDGET = 500` is separately enforced by the broker. An over-limit item is never truncated: the broker emits `append.rejected { reason: "over_budget" }` with `chars` or `tokens`, continues reading, and does not tell the one-way handler. Commentary should be a short spoken paraphrase of a consumer-confirmed result.

Unknown result kinds fail validation. Known result variants tolerate extra fields for additive compatibility.

A single raw line is limited to `MAX_NDJSON_LINE_BYTES = 65536`, counting UTF-8 bytes across chunks and whitespace lines. The LF delimiter is excluded; a CR before LF counts before being stripped. Crossing the bound throws `NdjsonLineTooLong` immediately, before waiting for a newline.

The timeout is one wall-clock budget from dispatch until `done` or clean end. Keepalive lines do not extend the budget. A timeout produces `delegation.finished { outcome: "timeout" }`. Nothing is spoken on the consumer's behalf; the broker generates no content of its own; items forwarded before the deadline stand. Items after `done` or after the broker decides an outcome are not read: the broker stops reading the stream when it decides an outcome.

## Remote handler authentication

The remote URL must use HTTPS, except HTTP is allowed for `localhost`, `127.0.0.1`, and `[::1]`. Userinfo, fragments, whitespace, malformed authorities, and redirects are rejected. Certificate verification is the runtime default and cannot be disabled.

The consumer supplies `auth: { type: "hmac-sha256", secret }`; it is per session only if the consumer chooses. Duplexd keeps the secret in memory, never logs or persists it, and never returns it.

The server sends:

- `duplexd-signature: t=<unix-seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`
- `duplexd-contract-version`, exactly once and equal to the signed body
- `duplexd-session-id`, exactly once and equal to the signed body

The signed body is authoritative. A handler stops at the first failure, before dispatch or side effect:

1. Verify the signature over raw bytes in constant time, then enforce the 300-second inclusive tolerance. Return 401 `invalid_signature` or `stale_timestamp`.
2. Parse JSON. Return 400 `malformed_body`.
3. Require each metadata header exactly once and equal to the body. Return 400 `metadata_mismatch`.
4. Require a supported body contract version. Return 400 `unsupported_contract_version`.
5. Validate `HandlerRequestLoose`. Return 400 `invalid_request`.

All failures use `application/problem+json`. The handler uses signed-body `(sessionId, delegationId)` as its idempotency key; metadata headers carry no authority.

## Call record

`CallRecord` is strict and contains no auth secret or consumer context. It preserves the provider session id unchanged and records:

```text
CallRecord {
  contractVersion: "1"
  sessionId: string
  provider: "openai-gpt-live"
  state: "closed" | "failed" | "incomplete"
  reason?: string
  createdAt: ISO-8601
  startedAt?: ISO-8601
  endedAt: ISO-8601
  usage?: { seconds: non-negative number, raw: JSON } // allowed only when closed
  instructions: string
  voice?: string
  handler: { type: "remote", url: string } | { type: "in-process" }
  transcript: Array<{ role, text, offsetMs }>
  delegations: Array<{ delegationId, offsetMs, outcome, createdAt, finishedAt?, appends }>
  appends: Array<{ seq, delegationId: string | null, kind, tokens, at }>
  rejectedAppends: Array<{ seq, delegationId: string | null, kind, reason, at }>
}
```

Delegation outcomes in records include `running`; rejection reasons are the same four values as `append.rejected`. A failed or incomplete record rejects a `usage` field.

## Provider mapping

| Contract             | OpenAI GPT-Live                                                                   |
| -------------------- | --------------------------------------------------------------------------------- |
| session create       | `session.start` over WebSocket, or `POST /v1/live/sessions` for WebRTC/SIP accept |
| `delegation.created` | `session.delegation.created` with `delegation.target: "client"`                   |
| `thinking`           | `session.thinking.append { delegation_id }`                                       |
| `commentary`         | `session.commentary.append { delegation_id }`                                     |
| `instruction`        | `session.instructions.append { delegation_id: null }`                             |
| `session.closed`     | `session.closed { usage }` after `session.close`                                  |
| transcript deltas    | `session.input_transcript.delta`, `session.output_transcript.delta`               |

Provider-specific events pass through `provider.raw` only when requested. Consumers never depend on them.
