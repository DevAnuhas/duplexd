# duplexd

A hosted voice-AI platform. Create an assistant, give it a voice, instructions, and tools, get an API key, and place calls against it from any project.

An assistant is a record: a voice and accent, instructions, a list of tools in the OpenAI function format, and a server URL the platform calls when a tool runs. Your backend exposes tool webhooks and nothing else — it never hands the platform its credentials, its data, or its business logic.

## The rule that shapes everything

**The voice model never receives tool definitions.** It listens and talks. A backend text model, owned by the platform, decides which tool to call and calls your webhook. The voice model holds no tools, no credentials, and no authority over what is true or what action to take.

This is not an implementation detail. It is why a second voice provider stays cheap to add, and why a caller can never talk the voice layer into doing something your backend did not authorize. It is recorded in [ADR 001](docs/decisions/001-client-delegation.md) and, as the approach now stands, [ADR 010](docs/decisions/010-pipecat-runtime.md).

## Shape

```
  caller ──audio──▶ Pipecat agent ──▶ voice model (instructions only, no tools)
                          │
                          │ "call a tool"
                          ▼
                   backend text model ──signed webhook──▶ your server
                          │
                          └──▶ spoken result, while the caller keeps talking
```

Three parts:

| Part | What it is |
| --- | --- |
| **Workspace** | Sign in, create and edit assistants, mint and revoke API keys, browse calls, transcripts, and usage. Next.js. |
| **Control API** | Start a call against an assistant with an API key; receive events; records and metering per key. Next.js route handlers under `/v1`, in the same app. |
| **Agent runtime** | One data-driven [Pipecat](https://github.com/pipecat-ai/pipecat) agent image. Per call it loads the assistant record and builds the pipeline. Python. |

## Status

Direction is settled and recorded in [ADR 010](docs/decisions/010-pipecat-runtime.md): Pipecat is the voice runtime, pinned as a dependency and never forked, and this project is the platform on top of it. A gate spike proved the loop end to end — a real call, a real webhook, honest results and honest failures — and it is kept at [`spikes/pipecat-gate/`](spikes/pipecat-gate/) as the regression test for a future Pipecat upgrade.

**The workspace app exists and runs.** `apps/workspace` is a Next.js app with sign-up, sign-in and an authenticated shell, backed by Postgres through Drizzle with the full schema applied. There is no assistant or API-key interface yet — that is the next ticket — and no call has ever been placed, because the agent runtime and control API come after it. Nothing is deployed.

An earlier milestone built a delegation engine from scratch — a TypeScript core, a wire contract, transports. ADR 010 retired it, and it has been removed. The ADRs that decided it are kept, superseded rather than deleted, because why a direction was abandoned is worth as much as why it was chosen.

## Where to start

[AGENTS.md](AGENTS.md) for working rules, then [CONTEXT.md](CONTEXT.md) for what this is, [ARCHITECTURE.md](ARCHITECTURE.md) for the boundaries, and [docs/MILESTONE.md](docs/MILESTONE.md) for the current build target. [docs/README.md](docs/README.md) maps the rest.

## License

MIT. See [LICENSE](LICENSE).
