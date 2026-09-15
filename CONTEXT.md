# Current context

## What duplexd is

duplexd sits between a full-duplex speech model and whatever system actually does the work. The speech model listens and talks; it does not think. When it needs a fact, a tool, or a decision, it signals for help. duplexd receives that signal, gathers the transcript and session context, hands it to a consumer backend, and streams whatever comes back into the conversation as spoken or silent context. The caller hears a conversation that keeps moving while work happens behind it.

The first supported model is OpenAI `gpt-live-1` in client-delegation mode. The design keeps the provider behind an interface so a second full-duplex model can be added without changing the consumer contract.

## What it is not

- Not a cascade. There is no speech-to-text, no separate reasoning model, no text-to-speech pipeline. Projects that need provider mixing already exist; this is not one of them.
- Not an agent framework. duplexd never runs tools, holds prompts for reasoning, or keeps memory beyond the current call. The consumer backend does all of that.
- Not a workflow builder or a dashboard product. The console exists to observe sessions and demonstrate the loop, not to configure agents.
- Not a media server. Telephony reaches duplexd through partner transports or direct SIP; duplexd does not terminate RTP itself.

## Direction

- **Contract first.** Every wire shape lives in `packages/contracts` and is exported as JSON Schema. A consumer in any language integrates against that schema. Two example handlers, one Node and one Python, must pass the same contract tests.
- **Two integration forms, one contract.** In-process (a TypeScript handler passed to the core) for consumers that embed duplexd; remote (an HTTP endpoint the server calls per delegation, streaming results back) for consumers in other languages or other processes. The remote form is what makes duplexd usable as a hosted service.
- **Transports in stages.** WebRTC for browser sessions first, because it demos locally with no telephony. Twilio Media Streams second, inbound and outbound. Direct SIP third. LiveKit only if concurrency or multi-party listening demands it.
- **Library first, service second.** The core is a library. The server wraps it with API keys, session records, and transport endpoints. A hosted offering is the server deployed with per-key metering, and it is not the first milestone.

## Defaults versus open questions

Settled enough to build on: TypeScript with Node 24 and pnpm workspaces; Fastify for the server; PostgreSQL through Drizzle for session and call records; a Vite and React console; the OpenAI Node SDK for the provider connection; Fly.io as the hosting target.

Deliberately open, to be decided against current APIs and recorded in `docs/decisions/`: exact package versions, the streaming shape of the remote handler (SSE versus WebSocket), whether the console shares a process with the server in production, the LiveKit transport, and any second provider.

Verify a candidate against a real compatibility check before committing to it. Do not silently swap an architectural choice without an ADR.

## Scope boundaries

A mock booking backend is the representative sample handler, not a chosen market. Any implementation must work for a second, contrasting handler without a separate hardcoded path.

Provider region placement, outbound calling compliance, recording retention, and custom voices are unresolved. Do not imply the product handles regulatory obligations for outbound calls; that stays with the consumer.

## Status

Documentation only. No application code, executable CI, deployment, or passing tests exist. The current build target and its acceptance evidence are in [the milestone](docs/MILESTONE.md).
