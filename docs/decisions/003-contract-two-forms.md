# 003: One contract, two integration forms

Status: superseded by 010
Date: 2026-09-15

## Context

Consumers fall into two groups: those that can embed a TypeScript library in their own process, and those in other languages or other processes that need to integrate over the network. A hosted offering is the second group by definition.

Two separate integration designs would drift. One design that only works in-process excludes most consumers.

## Decision

There is one contract, defined in `packages/contracts` and described in `docs/PROTOCOL.md`, with two delivery forms:

- **In-process:** the consumer passes a handler function to the core. The handler receives a `HandlerRequest` and returns an async iterable of `HandlerResult` items.
- **Remote:** the server sends the same `HandlerRequest` as an HTTP request to a consumer URL and reads the same `HandlerResult` items from a streamed response body.

Both forms are validated by the same contract test suite. An example handler exists in Node and in Python and both must pass it.

The exact streaming encoding for the remote form (newline-delimited JSON versus server-sent events) is decided in `packages/contracts` when it is implemented and recorded as an amendment to this ADR.

## Alternatives

**In-process only.** Rejected: excludes non-TypeScript consumers and rules out a hosted service.

**Remote only.** Rejected: forces a network hop on consumers that could run in-process, and makes the core untestable without a server.

**gRPC or a bidirectional WebSocket for the remote form.** Deferred. HTTP per delegation is simpler to implement in any language and adequate for the handler round-trip budget in milestone 1. A persistent connection becomes worth it if measured latency or concurrency demands it.

## Consequences

The contract must be language-neutral in practice, not just in intent. Anything that only works because of a TypeScript type is a contract bug.

Contract changes are versioned. The server declares the version in every request; a remote handler that cannot speak it returns `unsupported_contract_version`, as settled by ADR 008.

The Python example handler is a required deliverable of milestone 1, not a nice-to-have, because it is the only proof the second form works.
