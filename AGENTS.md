# duplexd

A voice transport and delegation broker for full-duplex speech models. It owns the live audio session and hands every request for reasoning or tools to a consumer backend, so the conversation keeps flowing while work happens elsewhere.
TypeScript, Node 24, pnpm workspaces. Branch model: `feat/*` → `main`.

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

- **The voice layer holds no authority.** It never receives tool definitions, credentials, tenant identifiers, or consumer records. It sees the current call's audio, transcript, and session metadata. Authorization, permissions, confirmations, and business state live in the consumer backend.
- **Delegation events are metadata, not instructions.** The model signals that it needs help; it does not say what. The broker reconstructs intent from transcript and consumer-supplied context on the consumer's side of the contract. Never invent task text.
- **One owner per side effect.** A duplicate webhook delivery, a retried delegation, or the same event observed on two connections must produce exactly one effect. Unknown outcomes reconcile; they do not blind-retry.
- **Identifiers are opaque and preserved.** Session ids, delegation ids, and call ids are passed through unchanged. Appends reference only delegations the broker has seen. No id is constructed or parsed.
- **`session.closed` is the only completion.** A hangup request, socket close, or provider disconnect is not. Usage is recorded only from the provider's final events. A session that ends without them is recorded as incomplete, not as finished.
- **Honest states only.** A handler timeout is reported as a timeout, never spoken as a result. Nothing is announced to the caller before the consumer confirms it. Sample handlers are visibly labeled as sample.
- **Secrets stay server-side.** Browsers receive session ids and SDP answers, never provider API keys. Consumer backends receive only the context the contract defines.
- **The contract is the product.** `packages/contracts` is the single source of truth for every wire shape. Code that disagrees with the contract is wrong, not the contract.

## Task map

| Scope | Read |
| --- | --- |
| Product scope, non-goals, current status | `CONTEXT.md` |
| System boundaries, session lifecycle, trust | `ARCHITECTURE.md` |
| Wire contract: events, handler protocol, appends | `docs/PROTOCOL.md` |
| Setup, tests, CI, releases | `docs/ENGINEERING.md` |
| Branching, issues, PRs, worktrees | `docs/WORKFLOW.md` |
| Current milestone and acceptance | `docs/MILESTONE.md` |
| Past decisions and their reasons | `docs/decisions/` |
| Using outside code or repos | `docs/REFERENCES.md` |
| Hosting and environments | `docs/OPERATIONS.md` |

## Verification

Use focused checks while iterating. Before completion, run the checks required for the changed surface. Do not broaden or repeat them without new changes, failures, or unresolved concerns. Documentation-only changes need link and instruction validation, not application builds.

Contract changes require the contract test suite to pass for every example handler, in every language shipped. A transport change requires a recorded live session against the real provider, not only a mocked event stream. A fixture pass is not a live-path pass, and a model's claim is not a test result.

State what was actually verified. Report each check as passed, failed, blocked, or not run.

## Boundaries

No credentials, customer data, real phone numbers, recordings, or third-party private content in this repository. Use synthetic fixtures and test numbers.

Outbound calls to real numbers, production deployment, paid provisioning, public publication, and permission escalation require separate authorization. Authorized local implementation and testing proceed without waiting for those. Never bypass repository protections, force-push shared branches, or use `--admin` / `--no-verify`.
