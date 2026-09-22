# 013: Sandbox admission is durable and execution is gated server-side

Status: accepted; one requirement superseded by [015](015-server-configured-sandbox-execution.md)
Date: 2026-09-21

## Context

Browser Sandbox tests need retry-safe ownership, quotas and bounded reservations
before provider dispatch is safe. The provider contract has not yet proved
finite cleanup for lost responses and agents that never register, so exposing a
start path now could create duplicate or unbounded paid sessions.

## Decision

Sandbox prepare writes one immutable Practice call snapshot, one durable attempt
and one per-user slot in a database transaction. The client supplies a UUID;
the server stores a canonical input digest and a hash of a 256-bit tab
controller proof. An account-row lock serializes account capacity, and durable
fixed-window counters enforce per-user and per-account admission limits.

Prepare creates no agent token, provider session or browser join credential.
Start, join and presence share a server-side disabled boundary with no provider
client or token-mint dependency. Stop can cancel and release only a
pre-dispatch reservation. Current and status reads return an allowlisted,
no-store projection.

Calls record their integration or Sandbox source explicitly. Existing rows
remain Integration by default, and the public API-key call path keeps its
existing immediate dispatch behavior.

## Alternatives

- A disabled button was rejected because direct HTTP requests and stale clients
  would bypass it.
- An in-memory mutex and counters were rejected because retries, multiple tabs
  and serverless process loss would defeat them.
- A fake provider implementation was rejected because it would make local
  fixtures look like evidence that the unresolved provider cleanup contract had
  passed.

## Consequences

The provider-independent lifecycle can be tested without creating an upstream
resource or credential. Expiry and cancellation release only reservations known
never to have dispatched. Provider dispatch, registration reconciliation, join
credentials and cleanup require a later additive change after the external gate
passes; this decision does not enable Sandbox or complete issue #62.
