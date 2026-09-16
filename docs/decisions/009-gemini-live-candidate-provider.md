# 009: Gemini 3.8 Live is the candidate second provider; provider limits live in adapters

Status: proposed
Date: 2026-09-16

## Context

ADR 001 and `ARCHITECTURE.md` both defer the second provider and say it would test whether the broker abstraction is real or GPT-Live-shaped. Google released `gemini-3.8-live` on 2026-09-15. It is the first Gemini Live model with asynchronous function calling on by default, mid-session client content, and input and output transcripts, so a "keep talking while the backend works" loop is possible. It lists 97 spoken languages, including Sinhala and Tamil; OpenAI publishes no language list for `gpt-live-1`. Language coverage is the concrete reason a consumer would ask for it.

Gemini differs from GPT-Live in ways that touch the core if the core is written carelessly:

- There is no delegation event. The model signals only through function calls, and function declarations are fixed at session setup.
- A function call takes one terminal `FunctionResponse` per call id. There is no append stream and no per-append token limit.
- The model may re-emit a function call that has not been answered.
- There is no final event carrying usage. Usage arrives periodically, the connection is reset roughly every ten minutes with a `GoAway` and a resumption handle, and audio-only sessions are capped unless context compression is on.
- Transport is WebSocket only. No WebRTC, no SIP. Audio is 16 kHz PCM in and 24 kHz PCM out; G.711 is not accepted.

## Decision

Gemini 3.8 Live is the candidate second provider. It is not part of milestone 1 and no adapter is built until a spike proves the loop works. Milestone 1 code follows four rules so the adapter can land as an adapter:

1. **Delegation ids come from the adapter.** The core treats any string the adapter supplies as the opaque delegation id and never assumes a provider event type. A Gemini adapter may derive it from a function call id.
2. **Provider limits are declared by the adapter, enforced by the core.** The per-append token budget, content byte bound, and append kinds an adapter supports are properties of the adapter, not constants of the broker. GPT-Live declares 500 tokens; an adapter that declares no budget gets no budget check.
3. **The adapter owns the provider connection lifecycle.** Reconnects, resumption handles, and periodic usage are inside the adapter. The core sees one session and one `closed` event. An adapter that cannot obtain a trustworthy final state emits `disconnected`, and the session is recorded `incomplete`. It never synthesizes `closed`.
4. **Transports declare which providers they support.** Browser-direct audio over WebRTC is a GPT-Live capability, not a duplexd guarantee. A provider without WebRTC uses `websocket-audio` with the server relaying audio. Telephony transports convert audio when the provider needs it.

The Gemini mapping the spike must prove: one generic, parameterless, non-blocking function declaration as the delegation signal, with the voice layer still holding no real tool definitions; `thinking` items as silent client content mid-session; `commentary` as the function response with idle scheduling; `instruction` as client content, since there is no runtime system-instruction update; dedupe of re-emitted calls in the broker. Whether silent client content injected without ending the turn stalls the model is unverified and is the spike's central question.

## Alternatives

**Gemini 3.8 Live Extended Thinking.** Rejected. It reasons in the voice layer and speaks its own fillers. duplexd exists to keep reasoning out of the voice layer.

**Gemini 3.1 Flash Live.** Rejected. Synchronous function calls only; the model waits for the result. The loop duplexd sells is impossible there.

**Make the generic function declaration a core concept.** Rejected. It is a Gemini adapter detail. ADR 001 still holds: no consumer tool schemas reach any provider.

**Build the adapter in milestone 1.** Rejected. Milestone 1 has one provider on purpose. The rules above are cheap now and the adapter is not.

## Consequences

`ProviderAdapter` gains a declared limits shape and `APPEND_TOKEN_BUDGET` moves from a broker constant to an adapter property. The remaining rules are already how the milestone 1 specs are written and cost nothing.

Milestone 1 still verifies nothing about Gemini. The next step is a bounded spike, tracked as #19: a Node script against `gemini-3.8-live` with the mapping above, one Sinhala and one Tamil call, and a recording of whether the model keeps talking while a slow handler works. Its result accepts or supersedes this record.

A Gemini adapter carries audio conversion for Twilio and a relayed browser path that GPT-Live does not need. That is adapter and transport work, and it does not change the consumer contract.
