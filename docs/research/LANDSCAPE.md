# Landscape

Pre-decision survey, September 2026. Reference only; decisions live in `../decisions/`. Claims were checked against project READMEs and provider documentation at the time and not re-verified since.

## What already exists

Self-hosted alternatives to managed voice-agent platforms:

| Project | License | Core | Voice mode | Telephony |
| --- | --- | --- | --- | --- |
| Dograh | BSD-2 | Python on Pipecat, workflow builder, MCP | cascade or speech-to-speech | Twilio, Vonage, Telnyx, Plivo, Asterisk |
| OpenVox | Apache-2 | Python single daemon, templates | cascade or S2S via Realtime | Twilio Media Streams |
| Feros | Apache-2 | Rust runtime, Python control plane | cascade | inbound gateway |
| Siphon | see repo | LiveKit worker | cascade | any SIP via LiveKit |
| Nenyax | AGPL-3 | LiveKit, per-agent sandbox | cascade | Twilio |
| Unpod | MIT | Django, FastAPI, LiveKit, Pipecat | cascade | SIP trunking |

Every one is cascade-first (speech-to-text, then a reasoning model, then text-to-speech) with speech-to-speech bolted on, and where speech-to-speech exists it targets the provider's turn-based Realtime API. None implement full-duplex client delegation. That is the gap duplexd fills. See ADR 001.

## Frameworks and partner layers

- **Twilio Agent Connect**: MIT, Python and TypeScript SDKs; the GPT-Live provider is Python-only and defaults to Responses delegation. Rejected as a dependency in ADR 002.
- **LiveKit Agents**: Apache-2, Python and Node, GPT-Live plugin, native SIP and numbers, dispatch and worker scheduling. Deferred in ADR 002.
- **Pipecat**: BSD-2, Python, GPT-Live service, transport-agnostic. Rejected in ADR 002.
- **Provider documentation**: WebRTC, WebSocket, SIP, delegation, session management, and partner integration guides at `developers.openai.com/api/docs/guides/` under `live*` and `voice-*`. Twilio's Node tutorial demonstrates the Media Streams to Live WebSocket bridge in roughly 150 lines.

## Patterns worth keeping, independent of stack

- A phone call and a text thread are the same conversation record with a channel-specific extension. Not adopted in milestone 1 (voice only) but the call record schema should not preclude it.
- Anything that can spend real money (an outbound call) gets its own scoped credential and hard limits, separate from a dashboard session.
- Routing decisions from caller identity before the model is engaged at all.
