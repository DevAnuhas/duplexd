# duplexd

A hosted voice-AI platform: a workspace where an assistant is given a voice, instructions, and tools, an API key per customer, and a call API any project can integrate. [Pipecat](https://github.com/pipecat-ai/pipecat) is the voice runtime.
TypeScript and Node 24 for the workspace and control API; Python and `uv` for the agent. Branch model: `feat/*` → `main`.

## Working approach

- Carry the requested task through implementation and verification. Make routine, reversible decisions without asking; ask when missing information materially changes scope or an action needs authorization.
- Report outcomes, evidence, and real blockers. Do not narrate routine tool use.
- Read the owning document before changing its surface. `docs/README.md` maps everything.
- Prefer existing patterns and dependencies. Refactor in place; no `_v2` or `_new` parallel implementations. Record material architecture decisions in `docs/decisions/`.
- Delegate independent investigation, implementation, or review when it saves time. Give each agent a bounded task and explicit file ownership. The parent integrates and verifies.

## Before implementation

Check for existing work once per workstream:

1. Search open issues and pull requests: `gh issue list --search "keywords"` and `gh pr list --state open --search "keywords"`.
2. Inspect repository state:

   ```bash
   git fetch --all --quiet
   git status --short
   git worktree list
   git branch -a --sort=-committerdate | grep -i KEYWORD
   ```

Resume active work instead of duplicating it. Preserve unrelated edits.

Work crossing two or more files uses a GitHub issue, a worktree from `main`, and a draft PR opened before implementation. Title the PR `type(scope): summary (#N)`, matching the commit format — the PR title becomes the squashed commit subject on `main`. Put the issue number in the branch name (`feat/12-short-slug`) and `Closes #12` in the PR body. Read-only questions and bounded investigations need none of that.

## Product invariants

These hold regardless of implementation detail. They are the rules worth blocking a change over.

- **The voice layer holds no authority.** It never receives tool definitions, credentials, tenant identifiers, or customer records. It sees the current call's audio, transcript, and instructions. Authorization, permissions, confirmations, and business state live in the customer's backend, reached only by a signed webhook. This is [ADR 001](docs/decisions/001-client-delegation.md), and [ADR 010](docs/decisions/010-pipecat-runtime.md) changed how it is implemented, not whether it holds.
- **One owner per side effect.** A duplicate webhook delivery, a retried tool call, or the same agent event ingested twice must produce exactly one effect. Unknown outcomes reconcile; they do not blind-retry.
- **A call is finished only when the agent says so.** A closed socket, a lost container, or a sweeper's timeout is not a completed call. A call that stopped reporting is recorded as incomplete with its last known duration, never as ended. Nothing else may write a clean ending it did not observe.
- **Honest states only.** A failed tool call is reported as failed, never spoken as a result. Nothing is announced to the caller before the customer's backend confirms it. Sample data is visibly labeled as sample.
- **Secrets stay server-side, and one of them is not ours.** API keys are shown once and stored hashed. The assistant's webhook secret belongs to the customer: encrypted at rest, decrypted only where a call needs it, and never returned by an API, rendered into a page, written to a log, or included in an error message.

## Task map

| Scope | Read |
| --- | --- |
| Product scope, non-goals, current status | `CONTEXT.md` |
| System boundaries, call lifecycle, trust | `ARCHITECTURE.md` |
| Setup, tests, CI, releases | `docs/ENGINEERING.md` |
| Branching, issues, PRs, worktrees | `docs/WORKFLOW.md` |
| Current milestone and acceptance | `docs/MILESTONE.md` |
| Past decisions and their reasons | `docs/decisions/` |
| Using outside code or repos | `docs/REFERENCES.md` |
| Hosting and environments | `docs/OPERATIONS.md` |

## Verification

Use focused checks while iterating. Before completion, run the checks required for the changed surface. Do not broaden or repeat them without new changes, failures, or unresolved concerns. Documentation-only changes need link and instruction validation, not application builds.

A change to how a call is authenticated, scoped, or recorded requires a test that fails without the change. A change to the agent requires a real call against the real provider, not only a mocked event stream. A fixture pass is not a live-path pass, and a model's claim is not a test result.

State what was actually verified. Report each check as passed, failed, blocked, or not run.

## Boundaries

No credentials, customer data, real phone numbers, recordings, or third-party private content in this repository. Use synthetic fixtures and test numbers.

Outbound calls to real numbers, production deployment, paid provisioning, public publication, and permission escalation require separate authorization. Authorized local implementation and testing proceed without waiting for those. Never bypass repository protections, force-push shared branches, or use `--admin` / `--no-verify`.
