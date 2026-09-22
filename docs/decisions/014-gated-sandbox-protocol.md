# 014: Develop the Sandbox lifecycle offline behind a closed production boundary

Status: accepted
Date: 2026-09-22

## Context

[ADR 013](013-disabled-sandbox-admission.md) established durable admission without execution. Private-session termination remains unproved, but the accepted server/runtime protocol can be implemented and tested independently of that proof.

## Decision

Extend the existing Sandbox module with a transaction-owned lifecycle and explicitly injected offline transports. The production singleton has no transport or enable switch. Registration, one-time Practice configuration and control use an explicit Sandbox-only protocol; Integration payloads do not acquire its fields or behavior. Release stays blocked by #60 and compatible runtime evidence.

Keep resource certainty separate from call state. Unknown dispatches retain capacity; exact observed identities, independently bound readback and persisted bounded stop attempts are the reconciliation inputs. Never infer resource or billing termination from a call ending or stop acknowledgement.

## Alternatives

- A UI-only gate or environment toggle permits premature dispatch without provider proof.
- Copying the spike framework creates another application engine instead of a narrow transport seam.
- Deferring all lifecycle work until live credentials arrive unnecessarily couples deterministic concurrency/ownership testing to provider access.

## Consequences

Offline tests verify application behavior, not live capability. The protocol can land before A04 without enabling calls, and unresolved resources remain visible. This extends ADR 013's staged implementation; its production gate remains intact. [The protocol document](../architecture/sandbox-protocol.md) owns the concrete handoff and rollback constraints.
