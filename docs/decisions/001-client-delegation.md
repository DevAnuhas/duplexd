# 001: Client delegation, not Responses delegation

Status: accepted
Date: 2026-09-15

## Context

The first supported provider, OpenAI GPT-Live, offers two ways to hand reasoning and tool use to a backend. In Responses delegation, the provider runs a hosted model with tool schemas the session registers up front, and the application executes function calls it is sent. In client delegation, the provider emits only an opaque delegation id; the application reconstructs intent from the transcript, runs whatever it wants, and returns results as appends. The mode is fixed at session start.

Consumers of duplexd already have their own agent runtimes, tool brokers, and authorization models. The point of the product is to give them a voice front end without moving any of that.

## Decision

duplexd uses client delegation exclusively. Sessions are created with `delegation.type: "client"`. The provider never receives tool definitions, backend instructions, or consumer data.

## Alternatives

**Responses delegation.** Rejected as the default: it requires registering tool schemas with the provider, moves tool-call decisions into a hosted model the consumer does not control, and forces consumer logic into the provider's function-call loop. It is the right choice for a green-field app without an existing backend, which is not who this product serves.

**Support both modes.** Rejected for now: it doubles the broker surface and the contract for a mode the target consumers do not need. Reopen if a consumer without a backend becomes a real user.

## Consequences

The handler request carries no task text. Consumers must infer intent from transcript and their own state, which is more work than receiving a function call but is what keeps authority on their side.

The broker owns append discipline: delegation ids, token budgets, and drop-after-finish. Those rules are enforced in code, not documented and hoped for.

A second provider with a different delegation model would test whether the broker abstraction holds. That would be its own ADR.
