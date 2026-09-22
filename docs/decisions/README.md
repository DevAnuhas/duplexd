# Decisions

Architecture Decision Records. One file per decision, numbered: `001-short-slug.md`.

Record a decision when it constrains later work and a future agent would otherwise re-litigate it: choosing a provider, a transport, the remote handler streaming shape, the hosting target, the storage layout, or any move away from what `CONTEXT.md` assumes.

Do not record routine package picks, file layout, or styling choices.

## Format

```markdown
# NNN: Title

Status: proposed | accepted | superseded by NNN
Date: YYYY-MM-DD

## Context

What forced a choice. Constraints and requirements that matter.

## Decision

What was chosen.

## Alternatives

What else was considered and why it lost.

## Consequences

What this makes easy, what it makes hard, what it commits us to,
and what would invalidate it.
```

Keep them short. An ADR explains why, not how — implementation detail belongs with the code.

Supersede rather than edit: mark the old record superseded and write a new one.

## Index

- [001: Client delegation, not Responses delegation](001-client-delegation.md) — accepted
- [002: Own the telephony bridges](002-own-telephony-bridges.md) — superseded by 010
- [003: One contract, two integration forms](003-contract-two-forms.md) — superseded by 010
- [004: TypeScript core with a language-neutral wire contract](004-typescript-core.md) — superseded by 010
- [005: Fly.io for the server](005-fly-hosting.md) — superseded by 011 for the platform layer
- [006: Remote handler results stream as newline-delimited JSON](006-remote-handler-ndjson.md) — superseded by 010
- [007: Handler timeout is one total budget, default 30 seconds](007-handler-timeout-default.md) — superseded by 010
- [008: Remote handler requests are HMAC-signed with a consumer-supplied secret](008-handler-request-signing.md) — superseded by 010
- [009: Gemini 3.8 Live is the candidate second provider; provider limits live in adapters](009-gemini-live-candidate-provider.md) — proposed
- [010: Pipecat is the voice runtime; this project is the platform on top of it](010-pipecat-runtime.md) — accepted
- [011: Vercel hosts the workspace and control API](011-vercel-hosting.md) — accepted
- [012: Practice uses immutable snapshots and a platform-owned signed backend](012-practice-snapshots.md) — accepted
- [013: Sandbox admission is durable and execution is gated server-side](013-disabled-sandbox-admission.md) — accepted
- [014: Develop the Sandbox lifecycle offline behind a closed production boundary](014-gated-sandbox-protocol.md) — accepted; extends 013
- [015: Enable Sandbox execution by server configuration](015-server-configured-sandbox-execution.md) — accepted; supersedes one sentence each in 013 and 014
