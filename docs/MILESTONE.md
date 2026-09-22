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

**A voice call has run through Duplexd.** On 2026-09-22, from a local workspace against a development database, a tenant prepared a Riley Practice test, pressed Start, and heard Riley say "Hi, I'm Riley, a synthetic demo voice assistant. This is a fictional practice session. How can I help today?" The call ran 88.7 seconds, ended with `client_disconnected`, recorded a duration, and its Pipecat session was confirmed stopped through the private-key path. A separate call proved two-way audio: Riley heard the caller and answered.

Execution is enabled by server configuration ([ADR 015](decisions/015-server-configured-sandbox-execution.md)). `sandbox/provider.ts` composes the #62 transport and the #63 lifecycle from five Pipecat variables and supplies the browser-media verifier the transport required; a deployment without them composes the no-transport lifecycle and answers 503 from start, join and presence, which is what production does until it is configured.

Running it for real is what found the bugs fixtures could not. Three timeouts were each shorter than the work they waited on, and every one ended a healthy call: the browser abandoned a start request that the server was still allowed to be working on, the presence lease went unrenewed for a full interval after audio connected even though the lease had been running since dispatch, and the agent gave its configuration claim five seconds — dying on a response the platform delivered at 4.8 seconds, having already marked the call active. All three are fixed and tested. The Next dev server is not usable for this work; local runs need a production build.

Still NOT RUN, and not to be counted: the tool round trip. No call has yet recorded a `tool_started`/`tool_finished` pair with its sample label, because the caller turn in the automated rig is driven by Chrome's fake audio device, which the agent hears too faintly to transcribe reliably. A human with a real microphone settles it. The Vercel preview call is also NOT RUN. Keyboard and 390 px passes for #64 are NOT RUN. Durable observations (#65) remain unfinished, and #29 acceptance (#66) has not been walked.

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
