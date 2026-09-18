# 007: Handler timeout is one total budget, default 30 seconds

Status: superseded by 010
Date: 2026-09-16

## Context

`docs/PROTOCOL.md` leaves `handlerTimeoutMs` with a default "to be decided in contracts". The broker must finish every delegation eventually: a handler that never answers would otherwise hold transcript snapshots, an open HTTP stream, and a delegation slot for the life of the session. The milestone requires that a timeout is reported as `delegation.finished { outcome: "timeout" }` and that nothing is spoken on the consumer's behalf, which means the broker never generates content of its own.

Two things could be timed: time to the first item, and total time to `done`. Two knobs are two things to explain, test, and get wrong in every handler language.

## Decision

`handlerTimeoutMs` is one wall-clock budget from the moment the broker dispatches the `HandlerRequest` to the moment the stream yields `done` or ends. Default `30000`. Accepted range `1000` to `120000`, validated in the contract schema. Keepalive lines (ADR 006) do not restart or extend it; they exist to keep proxies from closing an idle connection, and a handler that needs longer than the budget needs a bigger budget, not more keepalives.

On expiry the broker stops waiting and stops reading: it aborts the handler call (in-process: the request's abort signal and the iterator's `return`; remote: the HTTP request), emits `delegation.finished { outcome: "timeout" }`, and sends no append of its own. Items the broker forwarded before expiry stand; the model may already have spoken them. No further item from that delegation is forwarded after the deadline.

A timeout is a statement about the broker, not about the consumer. It means the broker stopped waiting. The consumer's work may have finished, may still be running, or may have failed; the broker does not know and does not claim to.

The timeout is per session, set in `SessionConfig`, not per delegation.

## Alternatives

**Two timeouts (first item, total).** Rejected for milestone 1 as premature. A later `handlerFirstItemTimeoutMs` can be added without breaking the shape.

**Longer default (60s or more).** Rejected: a result that arrives a minute after the caller asked is answering a conversation that has moved on. The model keeps talking during the delay; it does not wait.

**Shorter default (10s).** Rejected: a consumer that runs its own reasoning loop inside the handler routinely needs 10 to 20 seconds. The default should let the representative sample handler and a modest agent loop finish without tuning.

**Notify the model on timeout with a `thinking` append.** Deferred. It is arguably an honest state, not a fabricated result, but it is the broker injecting content into the conversation on the consumer's behalf. Milestone 1 stays silent; consumers steer the model with `instructions` ("if help does not arrive, say so"). Reopen with evidence from live sessions.

**Drain the handler after expiry to count what it would have sent.** Rejected: it delays the timeout by however long an uncooperative handler keeps talking, and the count would still be incomplete. The broker stops reading at the deadline; what a handler produces afterwards is never read and never counted.

## Consequences

The 30 second figure is a judgment, not a measurement. Revisit after recorded live sessions show real handler latency distributions.

The broker cannot guarantee that a consumer stopped a side effect at the deadline. A handler may commit work in the instant before the abort reaches it and never get to report it. The contract therefore places duplicate suppression and reconciliation with the consumer, per the `AGENTS.md` invariant that unknown outcomes reconcile and do not blind-retry: the handler treats `sessionId` plus `delegationId` from the signed body as the idempotency key, suppresses duplicates atomically, and decides for itself what to do with work it committed but could not report. The broker never retries a delegation. The example handlers demonstrate the suppression within one process lifetime and say so; a durable store is the consumer's job.

The default lives in `packages/contracts` so in-process and remote forms agree without configuration.
