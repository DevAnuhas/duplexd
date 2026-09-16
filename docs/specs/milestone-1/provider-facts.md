# Provider and toolchain facts: verified and unverified, 2026-09-16

What the planning pass could and could not verify. Specs and tickets cite this record rather than restating claims. Anything marked unverified must be confirmed by the ticket that first depends on it, and the confirming URL or package inspection goes in that PR and in this file.

## Verified against pinned documentation

Source root: `https://developers.openai.com/api/docs/guides/` (fetched 2026-09-16).

| Fact | Where |
| --- | --- |
| Model name `gpt-live-1`; connection paths are WebRTC, WebSockets, server-side controls, SIP | `live` |
| Two delegation modes, `responses` and `client`; chosen at session creation; immutable after start | `live-delegation` |
| Session config `{"model":"gpt-live-1","delegation":{"type":"client"}}` | `live-delegation` |
| Server event `session.delegation.created` with `offset_ms` and `delegation: { id, type: "delegation", target: "client" }` | `live-delegation` |
| Client events `session.thinking.append`, `session.commentary.append`, `session.instructions.append`, each with `delegation_id` (nullable) and string `content`, limited to 500 tokens per append; acks `session.*.appended` | `live-delegation` |
| "A non-null ID must name a known client delegation." Repeated appends may continue the same delegation. An `appended` ack is not proof the model consumed or spoke the result. | `live-delegation` |
| WebRTC: `POST /v1/live/sessions` with `{ session, transport: { type: "webrtc", sdp } }` using the project API key from the app server; response 201 `{ session: { id }, transport: { type: "webrtc", sdp } }`; browser data channel `oai-events`; no ephemeral client secret | `voice-webrtc?api=live` |
| Node SDK call `client.live.create({ session, transport })`, `import OpenAI from "openai"` | `voice-webrtc?api=live` |
| Server-side attach: `wss://api.openai.com/v1/live/sessions/{session_id}/attach` with `Authorization: Bearer`; receives transcript deltas, delegation events, reflected audio; may send appends, `session.update`, `session.close`; receives `session.closed` | `voice-server-controls?api=live` |
| WebSocket: `wss://api.openai.com/v1/live/sessions`; `session.start` then `session.started` (carries session id); `session.input_audio.append`, `session.output_audio.delta`; PCM16 at 24 kHz or 16 kHz, G.711 μ-law and A-law at 8 kHz; `session.input_transcript.delta`, `session.output_transcript.delta` with `delta` | `voice-websockets?api=live` |
| Node SDK `import { LiveWS } from "openai/resources/live/ws"`, `new LiveWS(new OpenAI())` | `voice-websockets?api=live` |
| `session.close` then `session.closed` with `reason` and `usage.seconds`; `session.usage.updated` snapshots (not increments); `reason: "expired"` on duration limit | `live-conversations` |
| The model listens and speaks concurrently; keep events, playback, and backend state separate | `live-conversations` |

The attach documentation says the attach connection "receives delegation events". That is a documentation claim, not an observation, and the entire server design rests on it; T05 observes it on a live session before T06 is merged.

## Verified by package inspection

| Fact | How |
| --- | --- |
| `openai@7.15.0` tarball contains `resources/live/` with `live.d.ts` (`class Live`, `create(body: LiveCreateParams)`), `ws.d.ts` (`class LiveWS`), `sideband/`, `forks/` | `npm pack openai@7.15.0`, 2026-09-16 |
| `openai@7.10.0` and earlier sampled versions contain no `resources/live/` | same |
| Latest npm versions on 2026-09-16: `openai` 7.15.0, `zod` 4.6.5, `fastify` 5.12.4, `drizzle-orm` 0.45.2, `vite` 8.3.0, `react` 19.3.0, `vitest` 5.0.1, `turbo` 2.10.13, `ws` 8.21.3, `gpt-tokenizer` 4.0.0; PyPI `fastapi` 0.141.1 | `npm view`, `pip index` |

Latest is not the same as chosen. Tickets pin exact versions after a compatibility check, per `CONTEXT.md`.

## Unverified

| Claim | Status | Confirmed by |
| --- | --- | --- |
| Which `openai` release introduced `resources/live` (somewhere in 7.11.0 to 7.15.0; changelog entries for 7.11 to 7.13 do not mention it) | unverified | T05 pins a version and records it |
| An attach connection to a live session receives `session.delegation.created` | documented, not observed | T05 opens an attach connection to its own live WebSocket session and asserts the event arrives there. Load-bearing for T06, T07, T08 |
| The provider emits a second `session.delegation.created` while the first is unanswered | not documented | T05 live session attempts to provoke it; broker supports it regardless |
| Error event and code when an append names an unknown `delegation_id` | not documented | T05 records the observed provider response |
| What "500 tokens" is counted in, and what the provider does with a 501-token append | unverified | T05 sends an append the default `o200k_base` counter measures at 501 tokens and records the response verbatim; T04 documents the chosen encoding as a guard |
| Events between `POST /v1/live/sessions` and attach connecting are replayed to the attach connection | unverified | T08 measures it |
| A REST close or delete exists for a live session the server is not attached to | unverified | T08 checks; `ProviderAdapter.abandon` is implemented with it if so, with a short-lived attach plus `session.close` otherwise |
| `session.closed.usage` fields beyond `seconds` | unverified | T05 records the raw object |
| The `LiveWS` helper supports the attach URL, or attach needs raw `ws` | unverified (SDK ships `sideband/` which may be it) | T05 and T08 |
| `session.started` also fires on an attach connection | unverified | T08 |
| Full `session.start` field names for `audio` format and `voice` | partially verified (examples only) | T05 |
| Text-to-speech endpoint and model available to generate the live test's synthetic PCM clip with the same API key | unverified | T05 names the endpoint and model used, and the output format it produced |

## Not checked

`docs/PROTOCOL.md` lists `session.closing` and `session.incomplete`. Those are duplexd states, not provider events, and need no provider verification.
