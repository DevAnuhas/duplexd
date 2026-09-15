# Current milestone: the delegation loop, end to end, in a browser

This is the active build target for any agent picking up work.

## Goal

A person opens the console, starts a call, talks to the model, asks for something that needs the backend, hears the model keep the conversation going while a sample handler works, and then hears the result spoken. They interrupt mid-sentence and the model handles it. The transcript and delegation timeline update live. When the call ends, a call record with usage is persisted and visible.

Two example handlers, Node and Python, pass the same contract tests. That is the proof the wire contract is language-neutral.

No telephony in this milestone. WebRTC only.

Read [CONTEXT.md](../CONTEXT.md), [ARCHITECTURE.md](../ARCHITECTURE.md), [PROTOCOL.md](PROTOCOL.md), and [ENGINEERING.md](ENGINEERING.md).

## Autonomy

Proceed with the stack in `CONTEXT.md`. Choose compatible packages, project structure, and styling independently and record material decisions in `docs/decisions/`. Do not wait for another comprehensive design approval before making reversible progress.

Use a mock booking backend as the representative handler. Define a second, contrasting handler early (for example, a mock order-status lookup) to catch handler-specific hardcoding in the broker.

## Build sequence

These are increments, not stopping points.

1. **Contracts.** `packages/contracts` with Zod schemas, exported JSON Schema, a contract test suite that any handler implementation can run against. Versioned from the first commit.
2. **Core.** Session state machine, transcript store, delegation broker, provider adapter interface, and the GPT-Live adapter over WebSocket. Unit tests drive the broker with a scripted fake provider: concurrent delegations, timeout, late results, oversized appends, close mid-delegation. One recorded live session against the real provider with a trivial in-process handler.
3. **Server and WebRTC.** Fastify server creating sessions, exchanging SDP, attaching for events, forwarding to remote handlers, persisting records. API key authentication. Postgres via Drizzle with docker compose locally.
4. **Console.** Start and end a call from the browser. Live transcript, delegation timeline with per-delegation outcome, session state, call history. Honest states for every failure the core can report.
5. **Example handlers.** `examples/handler-node` and `examples/handler-python`, both implementing the mock booking backend, both passing the contract tests, both runnable against the local server.
6. **Delivery.** Run everything locally through documented commands, record a demo session, establish CI, and prepare an evidence-backed PR.

## Acceptance evidence

Report each item as passed, failed, blocked, or not run:

- `pnpm install --frozen-lockfile`, lint, typecheck, and test pass from a clean clone with only `OPENAI_API_KEY` and a local Postgres configured.
- A browser call connects, the model speaks, the caller can interrupt, and the model recovers. Recorded, with the session id.
- A request needing the backend produces a `delegation.created` event, the handler receives a `HandlerRequest` matching the contract, and its `commentary` is spoken. The model keeps talking during the handler's simulated delay.
- Handler timeout produces `delegation.finished { outcome: "timeout" }` and nothing is spoken on the consumer's behalf. Tested with the delay forced past the timeout.
- Two concurrent delegations are tracked separately; results are routed to the right one. Tested with the scripted fake provider.
- An append over the token budget is rejected with an error event, not truncated. Tested.
- Session close waits for the provider's final event and records usage. A provider disconnect before that event produces an `incomplete` record, not a `closed` one. Tested with the fake provider.
- The Python example handler passes the identical contract test suite as the Node one.
- The console never receives the provider API key. Verified by inspecting what the server sends.
- Tooling, CI, setup, and implementation status are truthful and usable by the next agent without external chat context.

## Credentials and blockers

Read `OPENAI_API_KEY` from the environment without printing it. If provider access blocks the live path, complete the fake-provider path and contract tests, label the live session as blocked, and report it as blocked, not complete. Do not purchase resources or bypass an approval.

Use synthetic data. Production deployment, real telephony, and public publication require separate authority.

## Handoff

Deliver: actual launch commands; a recorded demo session; what works versus what is sample or blocked; acceptance results; and only the decisions genuinely needed next.

Update `ENGINEERING.md`, `CONTEXT.md`, and `ARCHITECTURE.md` to match what was implemented. Open a PR per `WORKFLOW.md`. Do not declare production readiness from a local run.

## After this milestone

Stage 2 adds the Twilio Media Streams transport, inbound and outbound, on the same core. Stage 3 adds direct SIP. Neither is ticketed until stage 1 has shipped, because both depend on decisions stage 1 has not made yet.
