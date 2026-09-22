# Current context

## What duplexd is

A hosted voice-AI platform. A customer creates an assistant in a workspace — a voice, an accent and style, instructions, a list of tools in the OpenAI function format, and a server URL — mints an API key, and places calls against that assistant from any project. The caller talks to the assistant; when the assistant needs a fact or an action, the platform calls the customer's webhook and speaks the result back while the conversation keeps moving.

The first customers are the user's own products, Boring Host and Dorian. They are waiting on this, and their backends expose tool webhooks and nothing else.

**The voice model never receives tool definitions.** A backend text model, owned by the platform, holds the assistant's tools, picks one, and calls the customer's webhook. This is the rule the gate spike proved and [ADR 010](docs/decisions/010-pipecat-runtime.md) records; [ADR 001](docs/decisions/001-client-delegation.md) is where it was first decided and it still stands.

[Pipecat](https://github.com/pipecat-ai/pipecat) is the voice runtime — a pinned dependency of the Python agent, never vendored or forked. It already ships the hard parts: async function calls that keep the conversation going, client delegation with a backend worker that owns the tools, telephony transports, and a hosted runtime. Building those from scratch was the previous milestone, and ADR 010 retired it.

## What it is not

- **Not a voice framework.** Pipecat is the framework. This is the platform on top of it: the records, the keys, the API, the call history.
- **Not a cascade.** No speech-to-text, separate reasoning model, and text-to-speech pipeline. The voice model is full-duplex.
- **Not a tool executor.** The platform never runs a customer's tool. It calls a webhook and relays what comes back. Permissions, confirmations, and business state live in the customer's backend.
- **Not a media server.** Audio reaches the agent through Pipecat's transports. Telephony, when it lands, goes through Pipecat's supported carriers.
- **Not billing.** Metering yes, invoicing no.

## Direction

- **The workspace is the product surface.** A human configuring an assistant is the point, not a side observation panel. This is the sharpest reversal from the retired milestone, which explicitly disclaimed being a dashboard product.
- **Two toolchains, one repository.** TypeScript for the workspace and control API; Python with `uv` for the agent. `agent/` proves a `uv` project lives inside this repo with CI green.
- **Both auth boundaries are load-bearing.** Human sessions can mint API keys and change the webhook destination that receives credentials, while API keys authorize integrating projects. Workspace auth therefore needs the same fail-closed treatment as the API-key boundary. Keys are hashed, scoped, rotatable and revocable.
- **Honest states over tidy ones.** A call that stopped reporting is recorded as incomplete, not as finished. Nothing claims a clean ending it did not observe.

## Settled, in the tech plan

Decided on 2026-09-18 and not worth reopening without new information:

| Decision                    | Choice                                                                                                                                               |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repo shape                  | Keep this repo. Add `agent/` (Python, `uv`) and `apps/workspace` (Next.js). The dead TypeScript packages and specs are pruned.                       |
| Where the control API lives | Next.js route handlers under `/v1`, in the workspace app, deployed to Vercel serverless functions ([ADR 011](docs/decisions/011-vercel-hosting.md)). |
| Backend model               | A per-assistant field, called through the **Responses API** — reasoning models reject function tools on chat completions.                            |
| Waiting behaviour           | A per-assistant field folded into the voice model's instructions. The platform injects no filler of its own.                                         |
| Workspace auth              | Better Auth on the platform's own Postgres. Load-bearing: a session can mint keys and redirect credentialed webhooks.                                |
| API keys                    | 32 bytes of CSPRNG, shown once, stored as prefix plus SHA-256, compared in constant time, revocable.                                                 |
| Webhook secrets             | The customer's own secret, encrypted at rest with AES-256-GCM, decrypted only when the agent fetches config. Never returned, never logged.           |
| Tool webhook auth           | HMAC-SHA256 over `"<t>." + raw body`, 300 s tolerance, per-assistant secret. The scheme from ADR 008 survives its contract.                          |
| Database                    | Postgres on Neon, Drizzle for schema and migrations.                                                                                                 |
| Concurrency                 | `min_agents = 0` at launch; cold start is measured, not paid for in advance.                                                                         |

## Still open

- **Product naming.** "duplexd" named a delegation daemon that no longer exists. The name becomes load-bearing when the workspace UI ships, not before; GitHub renames redirect.
- **Telephony.** Browser calls first. Telephony through Pipecat's supported carriers once browser calls work.
- **A second voice provider.** Gemini stays a candidate ([ADR 009](docs/decisions/009-gemini-live-candidate-provider.md)); Pipecat's adapter makes it cheap later.
- **Self-hosted agent regions.** Start on Pipecat Cloud; move if pricing or data residency demands it.
- **Custom cloned voices.** Gated by the provider; accent is by instruction until then.

Verify a candidate against a real compatibility check before committing to it. Do not silently swap an architectural choice without an ADR.

## Scope boundaries

One account per signup, one assistant, browser calls only in the first milestone. Accounts are isolated from each other from the first schema — that is a security boundary, not a feature — but _multi-user_ accounts need an invite flow nobody has asked for, so a signup owns exactly one account. Live call watching and a second provider are deliberately deferred so the first acceptance run stays reachable.

Recording retention, outbound calling compliance, and provider region placement are unresolved. Do not imply the platform handles a customer's regulatory obligations; that stays with the customer.

## Status

The Sandbox server/runtime pair is implemented for offline testing: owner-bound one-time configuration, independent runtime leases, readiness barriers, bounded replayable evidence and account-scoped ingestion-cursor polling complement exact-resource reconciliation. Production admission remains hard-disabled; #60 provider proof and real runtime/browser acceptance remain unproved. This is not closure of #62/#63. [Protocol and release boundary](docs/architecture/sandbox-protocol.md).

The workspace now exposes a **Sandbox preparation UI** for saved assistants and unsaved conversation previews, a Riley sample chooser, explicit sample authoring/review/save, revision-conflict recovery, local audio checks and durable prepare/cancel/status records. Voice start is disabled; this is partial progress on #64/#65, not a working browser call or Stage A acceptance. [Usage and remaining limits](docs/ENGINEERING.md#workspace-sandbox-preparation).

The engine milestone is retired. Its packages, specs, and wire-contract documentation have been removed from the tree — `docs/decisions/` keeps every superseded ADR, and git history keeps the code.

What exists at this commit: the documentation and decision trail, the CI workflow with its path classifier, and `apps/workspace`, the Next.js app. The Pipecat gate spike that proved the runtime end to end has served its purpose and been removed; git history keeps it.

The workspace, assistants, API keys, `/v1` control API, call history, and Python Pipecat agent are implemented and proven locally against the real database/provider seams available to the repository. Vercel/Neon configuration and an external sweep now exist in the tree, but dashboard setup and the first deployed preview/production run are still blocked owner actions. No production deployment or first-customer acceptance call has been claimed. The current build target and its acceptance evidence are in [the milestone](docs/MILESTONE.md).
