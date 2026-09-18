# 008: Remote handler requests are HMAC-signed with a consumer-supplied secret

Status: superseded by 010
Date: 2026-09-16

## Context

The server calls a consumer's handler URL once per delegation. The consumer must be able to reject requests that did not come from duplexd for that session, and must never receive its own duplexd API key back. `docs/PROTOCOL.md` says the server signs each request with a per-session secret issued at creation and leaves the scheme open.

Whoever creates the session is not always the process that serves the handler. In the milestone demo the console creates sessions through the server and a separate example handler process answers them. A secret the server mints per session at creation time is returned in the create response, which goes to the creator, and the creator has no channel to the handler. That rules out server-issued per-session secrets for this topology. It does not rule out a shared secret both sides read from their environment, which is what the demo does; the choice among the schemes that work with a shared secret is made below on other grounds.

A request signature authenticates the request. It does nothing for the response: the handler's result stream carries what the model will say, and the signature cannot protect it. The contract already allows any `http(s)` handler URL, so the response path needs its own protection or the allowed surface has a hole.

## Decision

`SessionConfig.handler` for the remote form carries `auth: { type: "hmac-sha256", secret: string }`. The consumer supplies the secret; it may be unique per session or shared across sessions, which is the consumer's choice. The server keeps it in memory for the life of the session, never persists it, never logs it, and never returns it in any response.

Every handler request carries:

- `duplexd-contract-version`: the contract version the server speaks
- `duplexd-session-id`: the provider session id, unchanged
- `duplexd-signature`: `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw request body>")>`

The signed body is authoritative. The two metadata headers exist for logs, traces, and proxies that cannot read a body; a handler acts on neither before the equality check below, and they carry no authority of their own. A handler verifies in this order and rejects at the first failure, before any dispatch or side effect:

1. Verify the signature over the raw body bytes with WebCrypto's constant-time HMAC verification and reject invalid signatures with 401 `invalid_signature`; only after a valid signature, reject `t` values more than 300 seconds from the handler's clock with 401 `stale_timestamp`. Everything unsigned, the headers included, is untrusted until this passes.
2. Parse the body.
3. Reject with 400 when either header is missing, carries more than one value, or differs from the signed body's `contractVersion` or `sessionId`.
4. Reject with 400 when the body's `contractVersion` is not one the handler speaks.
5. Validate the loose handler-request schema and reject invalid requests with 400.

A handler never uses the session header for authorization or as an idempotency key; it uses the body's `sessionId`.

The response path is protected by transport security, not by the signature. A remote handler URL must be `https:` unless its host is loopback (`localhost`, `127.0.0.1`, `[::1]`), which is the local-development exception the shipped examples use. The schema enforces the rule and the server applies it to its own default handler URL. The broker's HTTP client never follows a redirect: a 3xx response is a delegation error, so a redirect cannot change the destination or downgrade the transport. Certificate verification is the runtime default and is never disabled.

The delegation id inside the signed body is the replay boundary. A request replayed inside the 300 second window is the same delegation, so a handler that suppresses duplicates atomically on `sessionId` plus `delegationId` treats it as harmless. The contract requires that suppression of every handler; the contract package ships an isomorphic WebCrypto sign and verify helper, a documented algorithm, test vectors (secret, timestamp, body, expected signature) that the Python example handler verifies against, and a replay scenario in the conformance runner.

## Alternatives

**Static bearer token.** Rejected: the secret crosses the wire on every request and nothing binds it to the body, so a captured request can be replayed with a different transcript.

**Server-issued secret returned at session creation.** Rejected for milestone 1: it requires the session creator to distribute the secret to the handler before the first delegation, which the demo topology cannot do. It remains a reasonable addition for consumers whose creator and handler are the same process.

**Derived per-session keys (HMAC of a master secret and the session id).** Deferred. It works with the same shared master secret the demo already distributes by environment, and gives per-session isolation on top, at the cost of a second algorithm every handler must implement before it can verify anything. Add it as a second `auth.type` if a consumer needs it.

**Sign the response stream too.** Rejected: signing a chunked stream line by line is a second algorithm in every language, and TLS already covers the whole exchange. Revisit only if a consumer needs to terminate TLS somewhere it does not trust.

**Allow plain HTTP anywhere and document the risk.** Rejected: a documented hole is still a hole, and the invariant that nothing is announced before the consumer confirms it cannot survive an intermediary that can rewrite `commentary`.

**mTLS or signed JWTs.** Rejected: heavier than the problem in every language the contract must serve.

## Consequences

The scheme is the widely copied webhook-signature pattern, so handler authors in any language have prior art.

Two things in this record deliberately change what `docs/PROTOCOL.md` says, and acceptance updates that document: the secret is consumer-supplied, not server-issued; and it is per session only if the consumer makes it so. The old "per-session secret" wording overstated the isolation.

Header equality is a small tax on every handler, but it removes the case where two handlers route or validate the same authenticated payload differently because one read the header and the other read the body.

The secret is consumer data held in server memory. A process crash loses it with the session, which is correct: a session that cannot be signed for cannot be resumed anyway.

The console never sees the secret. In the demo the server reads a default handler URL and secret from its environment and uses them when a session request omits `handler`; that default exists for local development only and is a documented gap before any hosted deployment.
