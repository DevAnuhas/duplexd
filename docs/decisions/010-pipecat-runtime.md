# 010: Pipecat is the voice runtime; this project is the platform on top of it

Status: accepted
Date: 2026-09-18

## Context

The product goal, stated by the owner on 2026-09-18, is a hosted voice-AI platform in the shape of Vapi: a workspace where an assistant is given a voice, instructions, and tools in the OpenAI function format plus a webhook URL; an API key per customer; and a call API any project can integrate. First customers are the owner's own products.

Milestone 1 was building the engine for that from scratch: a TypeScript session state machine, delegation broker, provider adapter, and a language-neutral signed handler contract (ADRs 003, 004, 006, 007, 008). Two of twelve tickets had merged when research showed that [Pipecat](https://github.com/pipecat-ai/pipecat) (BSD 2-Clause, by Daily) already ships the hard parts: async function calls that keep the conversation going, GPT-Live in client delegation with a backend worker that owns the tools, a Gemini Live service, telephony transports, client SDKs, and a hosted runtime with usage pricing or self-hosting in a customer's own cluster.

A gate spike (issue #21, PR #22) ran `gpt-live-1` in Pipecat client delegation with tools generated from an assistant record and a webhook that took five seconds. Three calls: the invoice was read back correctly, a restart was relayed, an HTTP 500 became a spoken "the host is unreachable". Tool arguments were extracted from speech. The voice model held no tools. The model acknowledged then waited quietly rather than filling the gap; that is prompt tuning, not a runtime limit.

## Decision

Pipecat is the voice runtime. It is a pinned dependency of a Python agent, never vendored or forked. This project becomes the platform on top of it:

- **Workspace**: assistants, API keys, calls, transcripts, usage. Next.js.
- **Control API**: start a call against an assistant with an API key; events; per-key records and metering.
- **Agent runtime**: one data-driven Pipecat agent image. Per call it loads the assistant record and builds the pipeline: GPT-Live in client delegation, a backend text model through the Responses API holding the assistant's tools, each tool a webhook call to the assistant's server URL.

The voice model never receives tool definitions. ADR 001's principle stands; Pipecat's `ClientDelegation` with a `BackendLLMWorker` is how it is implemented now.

The backend text model is called through OpenAI's Responses API. Current reasoning models reject function tools on chat completions, and Pipecat's backend worker turns that error into an empty answer; the gate hit exactly this.

## Alternatives

**Finish the duplexd engine.** Rejected. Roughly ten more tickets before a first demo, rebuilding what Pipecat has, to own real-time infrastructure that is not the product.

**Vapi's model: register tools with the voice provider and let it call them.** Rejected earlier (ADR 001) and again here. It moves tool decisions into the voice model, makes a second provider harder, and loses the keep-talking loop unless the provider supports it.

**Hybrid: keep the signed handler contract as the customer-facing webhook standard, run Pipecat underneath.** Rejected. Under this decision customer webhooks are plain per-tool HTTP calls, which is what customers expect from the Vapi shape; the contract's distinctive idea, delegation without tools, is the thing the owner chose not to sell.

**Fork or vendor Pipecat.** Rejected. Every upstream fix for providers, turn detection, and transports would become a manual merge. Fork only if internals must change, which nothing here requires.

## Consequences

- ADRs 002, 003, 004, 005, 006, 007, and 008 are superseded by this record. 001 stands. 009 stands as proposed; a Gemini adapter is now Pipecat's `GeminiLiveLLMService` and the spike in #19 is about the product's use of it, not an adapter build.
- `packages/contracts` and the milestone 1 specs and tickets (#3 to #12) describe an engine that will not be built. They stay in history; `CONTEXT.md`, `README.md`, `ARCHITECTURE.md`, and `docs/MILESTONE.md` must be rewritten to describe the platform. That rewrite is the first ticket of the new milestone, not this ADR.
- The runtime is Python. The workspace and control API are TypeScript. Two toolchains in one repository, or two repositories, is open and decided with the workspace tech plan.
- Hosting: the agent image deploys to Pipecat Cloud first (Daily-run, usage-priced), with self-hosted regions available if pricing or data residency demands. Where the workspace and control API run is open; ADR 005's Fly.io choice may survive for them.
- Dependency on Daily: pricing, availability, and the pace of their GPT-Live integration. Mitigated by the BSD license, self-hosted regions, and the fact that the assistant record and webhook shape owe nothing to Pipecat.
- What would invalidate this: Pipecat's GPT-Live client delegation regressing or being dropped, or Pipecat Cloud pricing making per-minute margins impossible at the owner's price point. Either reopens the runtime question with the signed T03 contract in the Traycer epic as the resume point for an in-house engine.
