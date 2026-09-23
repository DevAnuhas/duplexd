# 015: Enable Sandbox execution by server configuration

Status: accepted
Date: 2026-09-22

## Context

[ADR 013](013-disabled-sandbox-admission.md) closes start, join and presence behind a boundary with no provider client, and [ADR 014](014-gated-sandbox-protocol.md) states that the production singleton "has no transport or enable switch" and lists an environment toggle among its rejected alternatives. Both were written while #60 — a six-case proof that Pipecat sessions terminate — stood between the merged code and any real call.

#60 has been retired as a gate. Pipecat already enforces the bound operationally: the Daily room carries the platform's own execution deadline with `eject_at_room_exp`, the private API exposes a session `DELETE`, the deployment runs `min 0 / max 1` under a spend cap, the agent watchdog polls control, and the five-minute sweeper terminates stale sessions through the merged transport.

The result of keeping the old sentence is that the admission, lifecycle, transport, agent runtime and browser client are all complete and merged, and nobody has ever completed a voice call through Duplexd. A boundary that cannot be opened by anything is not a gate; it is a wall.

## Decision

Sandbox execution is enabled by server configuration. `sandbox/provider.ts` composes the transport and the lifecycle from five environment variables — `PIPECAT_API_KEY`, `PIPECAT_PRIVATE_API_KEY`, `PIPECAT_ORGANIZATION_ID`, `PIPECAT_SERVICE_ID`, `PIPECAT_DEPLOYMENT_ID` — and is the only module permitted to read them. Configuration is all-or-nothing: a deployment missing any of them composes the no-transport lifecycle and answers 503 from start, join and presence, exactly as production does today.

This supersedes **only** two things: ADR 014's "The production singleton has no transport or enable switch" together with the rejected "environment toggle" alternative it belongs to, and ADR 013's requirement that provider dispatch wait for an external gate to pass. Everything else in both records stands, including the rules that made this module possible: nothing below the composition reads the environment, a browser argument still cannot opt into dispatch, resource certainty stays separate from call state, and termination is never inferred from a call ending or a stop acknowledgement.

The browser media verifier required by ADR 014's transport produces an expiry and nothing else: the Daily token's own `exp` when it decodes, clamped to the committed execution deadline, otherwise the deadline. It does not attempt to prove what the token was scoped to, because the provider's start contract does not expose that and reading back the properties we requested is not evidence.

## Alternatives

- **Keep the wall until #60 passes.** Eight live attempts completed none of its six cases. The proof harness is not the product and had become the only thing blocking every remaining ticket.
- **A UI or per-request flag.** ADR 014 rejected this and it is still right: a request the browser controls must not decide whether a paid agent starts.
- **Verify the media token's claims in the verifier.** Not possible against the published contract, and a check that reads back its own request is proof theatre.

## Consequences

A configured deployment can place real calls, and a misconfigured one is refused rather than half-enabled. `execution: "enabled"` in the attempt projection and the routes' behaviour now read the same predicate, so the browser cannot offer a Start the server will refuse.

The bound on a call is operational and should be described that way: execution deadline, room expiry, watchdog, sweeper, `max_agents = 1`, spend cap. Pipecat's deploy configuration has no session-duration field, so nothing here should claim a provider-enforced session ceiling.

The test suite clears these variables before every file, so a developer configured for a live call still runs the same suite as CI. Invalidated if the provider changes its start contract such that the session a start returns can no longer be identified against a fixed organization, service and deployment binding.
