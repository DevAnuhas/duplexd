# Traycer Epic brief

Prompt for the planning Epic. Verify the command name against the installed `/` menu before use; builds have shipped `/traycer-epic-brief` where the docs said `/trigger_workflow`. Attach the repository root so `AGENTS.md` is auto-detected.

Suggested sequence: epic brief, then tech plan, then `traycer-artifact-critique` on the tech plan, then ticket breakdown. Skip the UX workflow; this milestone has no UX beyond an observation console.

## Prompt

```
Plan the first milestone of this repository. Read AGENTS.md, CONTEXT.md, ARCHITECTURE.md, docs/PROTOCOL.md, docs/MILESTONE.md, docs/ENGINEERING.md, and docs/decisions/ before producing anything.

Produce focused specs, not one PRD: a Tech Doc for packages/contracts, a Tech Doc for packages/core, an API Spec for apps/server, a Tech Doc for the WebRTC transport, a short Design Spec for apps/console, and a Tech Doc for the example handlers. Each spec states its acceptance evidence in the terms docs/MILESTONE.md uses.

Generate ADR proposals for decisions the docs leave open and milestone 1 must settle: the remote handler streaming encoding (NDJSON versus SSE), the handler timeout default, and the per-session handler authentication scheme. Write them in the docs/decisions/ format with status "proposed".

Ticket only stage 1 of docs/MILESTONE.md: contracts, core with the GPT-Live WebSocket adapter, server with WebRTC, console, and the two example handlers. Do not ticket the Twilio transport, the SIP transport, LiveKit, hosting, or a second provider. Say explicitly in the plan that those are deferred and why.

Every ticket needs explicit acceptance criteria and must be independently implementable. Order them so contracts land first and everything else builds on the published contract package.

Constraints:
- The product invariants in AGENTS.md are non-negotiable. If any spec or ticket would violate one, flag it instead of writing around it.
- This is a planning Epic. Do not write application code.
- Where a package version, SDK capability, or provider behavior cannot be verified from documentation at a pinned URL, state it as unverified. Do not guess. In particular, the OpenAI Node SDK's Live support and the exact GPT-Live event names in docs/PROTOCOL.md are documentation-derived and must be confirmed by the first adapter ticket.
- Documentation-only changes to canonical files happen in the same ticket as the behavior they describe.
```

## Agent assignment

Claude Code on the Terminal interface as executor and coordination hub. Codex on the Chat interface for review and the critique pass. Review should come from a different model family than the implementer.

## After planning

Hand off tickets with plan handoff, not user-query handoff, for anything touching the contract, the broker, or a transport. User-query handoff is acceptable for console styling.

Append the repository's actual verification commands from docs/ENGINEERING.md to the handoff template once they exist.
