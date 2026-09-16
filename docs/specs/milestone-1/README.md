# Milestone 1: the delegation loop, end to end, in a browser

The planning specs for stage 1 of [`docs/MILESTONE.md`](../../MILESTONE.md). These files are the authority for the milestone's design; the Traycer epic that produced them now points here. Tickets are GitHub issues #1 to #12, which link back to these files.

| Spec | Covers | Issues |
| --- | --- | --- |
| [contracts.md](contracts.md) | `packages/contracts`: shapes, wire format, fixtures, conformance runner | [#2](https://github.com/DevAnuhas/duplexd/issues/2) |
| [core.md](core.md) | `packages/core`: session state machine, broker, adapter interface, GPT-Live adapter | [#3](https://github.com/DevAnuhas/duplexd/issues/3), [#4](https://github.com/DevAnuhas/duplexd/issues/4), [#5](https://github.com/DevAnuhas/duplexd/issues/5) |
| [server-api.md](server-api.md) | `apps/server`: routes, lifecycle, persistence | [#6](https://github.com/DevAnuhas/duplexd/issues/6), [#7](https://github.com/DevAnuhas/duplexd/issues/7) |
| [webrtc-transport.md](webrtc-transport.md) | `packages/transports/webrtc` and the browser half | [#8](https://github.com/DevAnuhas/duplexd/issues/8) |
| [console.md](console.md) | `apps/console` | [#9](https://github.com/DevAnuhas/duplexd/issues/9) |
| [example-handlers.md](example-handlers.md) | `examples/handler-node`, `examples/handler-python` | [#10](https://github.com/DevAnuhas/duplexd/issues/10), [#11](https://github.com/DevAnuhas/duplexd/issues/11) |
| [provider-facts.md](provider-facts.md) | what was and was not verified against provider documentation | cited by #5, #8 |
| [adr-proposals.md](adr-proposals.md) | ADRs 006, 007, 008: why, and what they change in `PROTOCOL.md` | accepted by #2 |

## What this is

duplexd puts a full-duplex speech model (OpenAI `gpt-live-1`) in front of a consumer's existing backend. The model listens and talks; when it needs a fact, a tool, or a decision it emits a delegation id and nothing else. duplexd hands the transcript and the consumer's own context to the consumer's handler, streams the results back into the conversation as silent context or spoken commentary, and records the call when the provider says it is over.

Milestone 1 builds that loop once, end to end, with a browser as the only transport. A person opens the console, talks, asks for something that needs the backend, hears the model keep going while a sample handler works, hears the result, interrupts, and sees the transcript and delegation timeline update live. When the call ends a record with usage exists. Two example handlers, one Node and one Python, pass the same contract tests.

## Why now

The repository is documentation only. Every design claim in `docs/PROTOCOL.md` and `ARCHITECTURE.md` is intended, not verified. The milestone exists to turn the contract into an executable package, prove the broker against a scripted provider and one real session, and produce evidence the next agent can trust. Telephony, hosting, and a second provider all depend on decisions this milestone makes (the contract shapes, the transport interface, the append discipline). Nothing later is safely plannable until this ships.

## Tickets

Ordered so the contract package lands first and everything else builds on it. Each is independently implementable against the published package it depends on and the spec it links, with its own tests and acceptance evidence. The issue body is the ticket.

| # | Issue | Depends on | Spec |
| --- | --- | --- | --- |
| T01 | [#1 Workspace scaffold and CI](https://github.com/DevAnuhas/duplexd/issues/1) | none | (self-contained) |
| T02 | [#2 Contracts package](https://github.com/DevAnuhas/duplexd/issues/2) | T01 | [contracts](contracts.md) |
| T03 | [#3 Core: session, transcript, adapter interface, fake provider](https://github.com/DevAnuhas/duplexd/issues/3) | T02 | [core](core.md) |
| T04 | [#4 Core: delegation broker and remote handler client](https://github.com/DevAnuhas/duplexd/issues/4) | T03 | [core](core.md) |
| T05 | [#5 Core: GPT-Live WebSocket adapter and live session](https://github.com/DevAnuhas/duplexd/issues/5) | T04 | [core](core.md), [provider facts](provider-facts.md) |
| T06 | [#6 Server: auth, sessions API, dispatch, event stream](https://github.com/DevAnuhas/duplexd/issues/6) | T04; design assumption confirmed by T05 | [server](server-api.md) |
| T07 | [#7 Server: persistence and call history](https://github.com/DevAnuhas/duplexd/issues/7) | T06 | [server](server-api.md) |
| T08 | [#8 WebRTC transport and live browser session](https://github.com/DevAnuhas/duplexd/issues/8) | T05, T06 | [webrtc](webrtc-transport.md) |
| T09 | [#9 Console](https://github.com/DevAnuhas/duplexd/issues/9) | T06 (API), T08 (live) | [console](console.md) |
| T10 | [#10 Example handler: Node](https://github.com/DevAnuhas/duplexd/issues/10) | T02 | [handlers](example-handlers.md) |
| T11 | [#11 Example handler: Python](https://github.com/DevAnuhas/duplexd/issues/11) | T02 | [handlers](example-handlers.md) |
| T12 | [#12 Delivery: acceptance run, demo recording, docs truth-up](https://github.com/DevAnuhas/duplexd/issues/12) | all | `docs/MILESTONE.md` |

Parallelism: after T02, T03 and T10 and T11 can run at once. After T04, T05 and T06 can run at once. T07 and T09 (against the API spec) can start once T06 exists. T06 may start before T05 finishes, but its design rests on the attach connection delivering `session.delegation.created`, which T05 confirms; if T05 fails that check, T06 stops and an ADR is opened.

Rules every ticket inherits:

- The invariants in `AGENTS.md` are non-negotiable. If an implementation detail would violate one, stop and flag it in the PR; do not write around it.
- Documentation changes to canonical files (`CONTEXT.md`, `ARCHITECTURE.md`, `docs/PROTOCOL.md`, `docs/ENGINEERING.md`) land in the same PR as the behavior they describe. The tickets list the exact sentences they change.
- Unverified provider or SDK facts are confirmed by the ticket that first depends on them; the confirming URL or inspection goes in the PR and in [provider-facts.md](provider-facts.md) or `docs/PROTOCOL.md`.
- Report each acceptance item as passed, failed, blocked, or not run. A fixture pass is not a live pass.
- Branch from `main`, issue first, draft PR, `type(scope): summary (#N)`.

## Deferred, and why

Not ticketed. Each depends on something stage 1 has not produced yet.

| Deferred | Why not now |
| --- | --- |
| Twilio Media Streams transport | Needs the transport interface shape that the WebRTC adapter settles, a public tunnel, paid number provisioning (human-authorized), and the `audio.format` contract field exercised for the first time. `docs/MILESTONE.md` says stage 2 is not ticketed until stage 1 ships. |
| Direct SIP transport | Provider SIP enablement is per project and gated; the EU versus US endpoint choice is an operations decision. ADR 002 already marks it blocked until enablement is confirmed. |
| `websocket-audio` transport | Listed in `ARCHITECTURE.md` but not in the milestone goal. It has no consumer in this milestone and would be a fixture-only pass, which `AGENTS.md` says proves nothing about timing. |
| LiveKit | Deferred in ADR 002 until concurrency or multi-party listening demands it. Nothing in stage 1 does. |
| Hosting (Fly.io, Neon, environments) | ADR 005 fixes the target and says nothing deploys until milestone 1 works locally. Hosting also needs a real key store to replace `DUPLEXD_API_KEYS`. |
| Second speech provider | `ARCHITECTURE.md` frames it as the test of whether the broker abstraction is real. That test needs a working broker first. |
| Console shares a process with server in production | Open in `CONTEXT.md`, only matters at deploy time. |

## Invariant pressure points

Places where the design pushed on an `AGENTS.md` invariant. None are violated; each is named so the implementer does not quietly resolve it the wrong way.

1. **Secrets stay server-side, WebRTC.** Verified: GPT-Live's WebRTC flow has the app server post the SDP offer to the provider with the project key and return only the answer and session id to the browser. No ephemeral browser token is needed. The browser data channel does carry provider events, but the broker consumes events over the server's attach connection, never from the browser. Routing delegation events through the browser would be an integrity hole and an ADR, not a shortcut.
2. **Honest states, handler timeout.** ADR 007 has the broker generate no append of its own on timeout. Telling the model "help did not arrive" would be arguably honest but is the broker injecting content on the consumer's behalf. Deferred, recorded as open. The invariant cuts the other way too: a timeout is reported as the broker's state, not as "nothing was spoken", because a handler heard before the deadline was heard. The console and every acceptance item say "handler timed out" and show the append history.
3. **Voice layer holds no consumer records, `consumerContext`.** The opaque blob is echoed to the handler and never persisted. Holding it at rest would make duplexd a store of consumer data.
4. **The console holds a consumer API key.** In the demo the console acts as the consumer and needs a duplexd API key. That is a consumer key, not a provider key. It is typed into the console and kept in browser local storage, never built into the bundle. Before any hosted deployment the console needs its own auth; a gap, not a milestone item.
5. **Sample handlers visibly labeled.** The console shows a sample-handler banner, the handlers' READMEs and startup logs say sample, and every handler's first `thinking` item tells the model the data is mock data. Spoken confirmations stay natural.
6. **One owner per side effect, timeout race.** The broker cannot know whether a handler finished a side effect at the deadline. ADR 007 places duplicate suppression with the consumer, keyed on `(sessionId, delegationId)`; the broker never retries and never drains. The example handlers show the suppression within one process and say a real consumer needs durable storage.
7. **Identifiers are opaque, creation failure.** A provider that rejects session creation before allocating an id leaves nothing to key an event or record on. The core throws, the server returns 502, and no record exists; `failed` is reserved for sessions that got an id. No id is minted to fill the gap.
8. **Honest states, crash mid-call.** `ARCHITECTURE.md` promises an `incomplete` record from a crash. A hard crash writes nothing at the terminal state, so the server writes one row at session start and a boot-time sweeper marks orphans `incomplete { reason: "instance_lost" }`. That record has no transcript, and T07 amends the `ARCHITECTURE.md` sentence to say so.
9. **Honest states, over-budget commentary.** The result stream is one-way, so a handler cannot learn that the broker rejected its `commentary`. The contract caps `content` in characters at the schema level so every language rejects it before sending, and the token budget stays as the second line. A rejection is visible in the event stream and the call record; the handler itself is not told.

## Open questions (recorded as open, not resolved)

- Whether the provider replays events that occur between `POST /v1/live/sessions` and the server's attach connecting. Unverified. T08 measures it.
- Whether the provider emits a second `session.delegation.created` before the first receives appends. Not documented. The broker supports it regardless; T05 tries to provoke it.
- Which tokenizer matches the provider's 500-token append budget. Unverified. T05 sends a deliberately over-budget append and records the provider's response.
- Which `openai` npm release introduced the Live resource. Present in 7.15.0; the floor is unverified. T05 pins whatever it verifies.
- Whether a REST close exists for a live session the server has not attached to. Unverified. T08 checks it, because attach failure after creation otherwise orphans a provider session.

## Verification standard

Every spec ends with acceptance evidence phrased the way `docs/MILESTONE.md` phrases it: a list of items each reported as passed, failed, blocked, or not run. A fixture pass is not a live pass; a live session id goes in the PR. Documentation changes to canonical files land in the same ticket as the behavior they describe.
