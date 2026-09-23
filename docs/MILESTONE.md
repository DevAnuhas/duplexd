# Current milestone: a call from a real project, against an assistant someone created

This is the active build target for any agent picking up work.

## Goal

Someone signs in to the workspace, creates an assistant — voice, instructions, a tool in the OpenAI function format, and a server URL — and mints an API key. A Boring Host page uses that key to place a call. The caller talks; the assistant calls the tool; the tool hits Boring Host's real backend; the answer is spoken back while the conversation keeps moving. Afterwards the call, its transcript, and its tool calls are visible in the workspace.

That is the closing condition of the epic brief, and it is deliberately end to end: it fails if any one of the workspace, the schema, the key, the control API, or the agent is missing.

Browser calls only. No telephony in this milestone.

Read [CONTEXT.md](../CONTEXT.md), [ARCHITECTURE.md](../ARCHITECTURE.md), and [ENGINEERING.md](ENGINEERING.md).

## Autonomy

Proceed with the decisions already recorded in `CONTEXT.md` and the tech plan. Choose compatible packages, project structure, and styling independently, and record material decisions in `docs/decisions/`. Do not wait for another comprehensive design approval before making reversible progress.

## Build sequence

Each is a ticket, each independently mergeable, in this order because each needs the one before.

| #       | Ticket                                                                                                   | Ends when                                                                              | State                                                               |
| ------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| P01     | Prune the retired engine and re-orient the docs                                                          | The repository describes the platform and the build commands are green on what remains | [#24](https://github.com/DevAnuhas/duplexd/issues/24) — done        |
| P02     | Workspace foundation: Next.js app, Better Auth, Drizzle, the schema, deploy configuration                | A human signs in to an empty workspace                                                 | [#25](https://github.com/DevAnuhas/duplexd/issues/25) — done        |
| P03     | Assistants and API keys: CRUD, tool-list validation, key issue and revoke                                | An assistant with tools exists and a key can be minted and revoked                     | [#26](https://github.com/DevAnuhas/duplexd/issues/26) — done        |
| P04     | Agent runtime: the gate spike generalized, config fetched from the API, deployed to Pipecat Cloud        | A real call runs against a real assistant record                                       | [#27](https://github.com/DevAnuhas/duplexd/issues/27) — done        |
| P05     | Control API: `POST /v1/calls`, room handoff, call rows, agent event ingest, completion, stale-call sweep | A call placed by API key is recorded start to finish                                   | [#28](https://github.com/DevAnuhas/duplexd/issues/28) — done        |
| Hosting | Vercel configuration, isolated preview migrations, external sweep                                        | The platform can be deployed without a permanent workspace process                     | [#42](https://github.com/DevAnuhas/duplexd/issues/42) — in progress |
| P06     | Acceptance: a Boring Host page places a call against a real backend tool                                 | The goal above                                                                         | [#29](https://github.com/DevAnuhas/duplexd/issues/29)               |

P04 and P05 can overlap: the agent can be exercised from the CLI before the control API exists, which is exactly how the gate spike ran.

## Sandbox increment status

**A voice call has run through Duplexd, and a human has heard it.** On 2026-09-22, from a local workspace against a development database, a tenant prepared a Riley Practice test, pressed Start, and the call ran to completion: 88.7 seconds (`6dd8ea8c-6e75-4c01-ac5f-1a2b671bbad5`), ended with `client_disconnected`, recorded a duration, and its Pipecat session was confirmed stopped through the private-key path.

That call, and every call before it, was **silent at the caller's end** — a fact discovered later the same day and corrected in `a69a119`. The transcript recorded Riley's greeting, which is what the earlier version of this paragraph mistook for the caller hearing it. Chromium does not decode a remote WebRTC track consumed only by a `MediaStreamAudioSourceNode`: measured on a loopback, packets arrived and `totalSamplesReceived` stayed at 0 until an `<audio>` element was attached. So "two-way audio" was half true. `0a0a37ec-0718-4168-a9e5-659228ecb016` proves Riley heard the caller — a real microphone, `transcript_user` "Hello", two assistant replies — and proves nothing about the other direction.

**Audible playback is now observed**, by the one instrument that can observe it: a person wearing headphones. Call `7dc718d6-2e23-4582-ae74-b7348607b1fb`, 37.3 seconds, `ready_at` set, ended `client_disconnected`, resource `confirmed_stopped`. Four human turns, four audible answers. Asked why a failed lookup had failed, Riley said she did not know rather than inventing a cause. No test in this repository asserts audibility and none can — a browser test environment has no speakers — so the method is recorded here instead of implied: human ear, headphones, on a production build.

Execution is enabled by server configuration ([ADR 015](decisions/015-server-configured-sandbox-execution.md)). `sandbox/provider.ts` composes the #62 transport and the #63 lifecycle from five Pipecat variables and supplies the browser-media verifier the transport required; a deployment without them composes the no-transport lifecycle and answers 503 from start, join and presence, which is what production does until it is configured.

Running it for real is what found the bugs fixtures could not. Three timeouts were each shorter than the work they waited on, and every one ended a healthy call: the browser abandoned a start request that the server was still allowed to be working on, the presence lease went unrenewed for a full interval after audio connected even though the lease had been running since dispatch, and the agent gave its configuration claim five seconds — dying on a response the platform delivered at 4.8 seconds, having already marked the call active. All three are fixed and tested. The Next dev server is not usable for this work; local runs need a production build.

**The tool round trip fires, and has never once succeeded.** Two calls recorded a `tool_started`/`tool_finished` pair — `daf16f99-934c-4f07-9780-3e2ffc6ed3d4` and `7dc718d6-2e23-4582-ae74-b7348607b1fb` — so the assistant decides to call the tool, the delegation is created, and the result is persisted. Every one failed: `outcome=failure`, `errorCategory=webhook_unreachable`, at `durationMs` 2049 and 2048 against a 2-second budget. On both, the assistant refused to invent the answer it could not look up.

Those failures are a **local-tunnel artefact and not a product fault**: the agent runs on Pipecat Cloud and reaches a laptop through ngrok, and the tunnel alone consumes the budget before the handler is entered. It is also why `WEBHOOK_TIMEOUT_SECS` has not been changed — the only honest measurement is `durationMs` from a preview call, where there is no tunnel hop, and that has not been taken.

Still NOT RUN, and not to be counted: **a successful tool result**. The Vercel preview call is NOT RUN, and voice execution is not configured in the Preview environment, so it cannot be run there today. Keyboard and 390 px passes for #64 are NOT RUN. Durable observations (#65) remain unfinished, and #29 acceptance (#66) has not been walked.

The caller turn still cannot be driven by the automated rig: Chrome's fake audio device attenuates the synthesised caller by about 15 dB (−12.7 dB at source against −28.3 dB captured), which the agent hears too faintly to transcribe reliably. Every user turn recorded so far came from a human microphone.

#39 marks non-runnable assistants in the assistant list using the existing Practice predicate — a badge, no new validator — and is unit-tested but not yet confirmed in a browser.

See [Sandbox usage](ENGINEERING.md#workspace-sandbox-preparation) and the [protocol handoff](architecture/sandbox-protocol.md); do not count local audio or preparation as a real call.

## Acceptance evidence

Report each item as passed, failed, blocked, or not run.

- `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` pass from a clean clone.
- A human signs up, signs in, and reaches an empty workspace on a real URL.
- An assistant is created with a voice, instructions, and a tool list, and round-trips through an edit without losing a field.
- A tool list with a malformed `parameters` schema is rejected at save, with a message naming the offending tool, and the rest of the form survives the error.
- An API key is minted, shown exactly once, and is not recoverable afterwards from the workspace or the database. Revoking it stops it authenticating.
- A second signup's account cannot read the first account's assistants, keys, or calls.
- An assistant's webhook secret is encrypted at rest and appears in no API response, rendered page, log line, or error message.
- A call placed by API key runs end to end and is recorded with its transcript and tool calls.
- A call whose agent stops reporting is recorded as `incomplete`, not as `ended`.
- Migrations apply cleanly from empty and are idempotent on a second run.

## Credentials and blockers

Read every credential from the environment without printing it. Use synthetic data. If provider access blocks a live path, complete what can be completed, and report the live path as blocked rather than as complete.

Production deployment, real telephony, outbound calls to real numbers, paid provisioning, and public publication require separate authorization.

## Handoff

Deliver actual launch commands, what works versus what is sample or blocked, acceptance results, and only the decisions genuinely needed next. Update `ENGINEERING.md`, `CONTEXT.md`, and `ARCHITECTURE.md` to match what was implemented. Open a PR per [WORKFLOW.md](WORKFLOW.md). Do not declare production readiness from a local run.

## The retired milestone

The previous target was a from-scratch delegation engine — a TypeScript core, a wire contract, transports — sequenced across issues #3 to #12. [ADR 010](decisions/010-pipecat-runtime.md) retired it after a gate spike showed Pipecat already shipped the hard parts. Those issues are closed as not planned, each citing ADR 010, and the code and specs have been removed from the tree. The ADRs that decided them are kept and marked superseded; git history keeps the rest.

## After this milestone

Telephony through Pipecat's supported carriers, then live call watching in the workspace. Neither is ticketed, because both depend on decisions this milestone has not made yet.
