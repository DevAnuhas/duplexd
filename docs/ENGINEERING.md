# Engineering

Setup, verification, CI, and releases. This file owns supported commands and actual verification evidence. The commands below are executable today; application startup is planned until the tickets named below land.

## Toolchain

- Node `24.21.0` (`.node-version`) and pnpm `12.4.2` (including its Corepack integrity hash in `package.json`). Use `corepack enable` or install that exact pnpm version.
- TypeScript `6.0.3`, ESLint `10.10.0`, typescript-eslint `8.70.0`, Prettier `3.9.6`, and Vitest `5.0.1`.
- Markdown links are checked by `markdown-link-check` `3.15.0` through `pnpm lint:links`.
- Python 3.12+ and `uv` for `spikes/pipecat-gate/`, and later for `agent/`.
- `pnpm install --frozen-lockfile` locally and in CI. Exact pins, one committed lockfile.

## Layout

```
scripts/          classify-docs-only.sh, the CI path classifier
tests/            the classifier's suite, run by the root Vitest runner
spikes/pipecat-gate/   the passing Pipecat gate (Python, uv), kept as a regression test
docs/             documentation and the decision trail
```

There are **no pnpm workspace packages at this commit**. The root `package.json` is the only manifest, and `pnpm-workspace.yaml` carries pnpm settings rather than a package glob. P02 adds `apps/workspace` as the first package.

### The Python side, planned

`agent/` **does not exist yet — it lands in P04.** When it does, it will be a Python project managed by `uv`, sitting *outside* the pnpm workspace, following the layout `spikes/pipecat-gate/` already proves works here: its own `pyproject.toml` and `uv.lock`, no entry in `pnpm-workspace.yaml`, and no pnpm script wrapping it.

The Python toolchain gets its own CI job with its own `uv` cache, independent of the pnpm job. Two toolchains in one repository is a decision, not an accident; the existing path classifier already routes documentation-only changes away from both.

## Verification

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm lint:links
```

All commands require no environment variables, no database, and no Docker.

What each one actually does at this commit — stated plainly, because a command that reports green while running nothing is worse than one that fails:

| Command | What it runs | Real coverage |
| --- | --- | --- |
| `pnpm lint` | `bash -n` over the classifier script, then ESLint over `eslint.config.js`, `vitest.config.ts`, and `tests/`, with `--max-warnings=0` | yes |
| `pnpm typecheck` | `tsc --noEmit` over `tests/**` and `vitest.config.ts` against the root `tsconfig.json` | yes |
| `pnpm test` | `vitest run` — the 41 classifier tests under `tests/` | yes |
| `pnpm build` | **A stated no-op.** It prints that there is nothing to build and exits 0. There is no TypeScript to compile until P02 adds the workspace app. | none, deliberately |
| `pnpm lint:links` | `markdown-link-check` over every Markdown file | yes |

### Why Turbo is gone

Turborepo was removed in P01. With every workspace package deleted, `turbo run test` and `turbo run lint` resolved to an empty task graph: Turbo reported `Running <task> in 0 packages`, `WARNING No tasks were executed`, and **exited 0** without running the `//#test:scripts` and `//#lint:root` root tasks. The classifier tests and root ESLint would have silently stopped running while both commands still reported success.

The alternatives were worse. An empty `packages: []`, or no workspace file at all, made Turbo hard-error on the `//#` root tasks. Single-package mode worked only with the root tasks removed and the scripts renamed to avoid `turbo run test` re-entering the root `test` script, which is Turbo wrapping exactly one command behind an indirection.

So the root scripts call `vitest`, `eslint`, and `tsc` directly. `package.json` alone now shows why the classifier tests run. P02 reintroduces Turbo if a real package graph makes it earn its place.

### Planned application run

*None of this works yet; P02 and P04 own it.*

```bash
pnpm install --frozen-lockfile
pnpm db:migrate                # P02
pnpm dev                       # P02, the workspace app
uv run --directory agent bot   # P04
```

## CI

`.github/workflows/ci.yml` always starts for pull requests and pushes to `main`. Its `changes` job runs the repository's merge-base-aware path classifier. Code changes run frozen install, lint, typecheck, test, and build in `checks`; documentation-only changes run `pnpm lint:links` in `docs`. The unselected job reports skipped rather than disappearing, so later branch protection can require the stable check names recorded in [WORKFLOW.md](WORKFLOW.md).

The classifier is covered by 41 tests in `tests/classify-docs-only.test.ts`, run by `pnpm test`. They are the reason a change to the routing rules cannot land silently.

## Data

*Planned; P02 owns it.* Drizzle migrations, generated with `pnpm db:generate`, committed, applied with `pnpm db:migrate`. No hand-written migrations. Postgres on Neon; see [OPERATIONS.md](OPERATIONS.md).

## Environment variables

None are read by anything in the repository at this commit, so there is no `.env.example` to copy. P02 reintroduces one with the variables its schema and auth actually need. Never commit values.

## Releases

None yet. When the workspace app is deployable, releases are tagged from `main` and deployed per [OPERATIONS.md](OPERATIONS.md) with human approval for production.

## Evidence

- 2026-09-16 — PR [#15](https://github.com/DevAnuhas/duplexd/pull/15) code path: [CI run 35058950023](https://github.com/DevAnuhas/duplexd/actions/runs/35058950023) passed `changes` and `checks`; `docs` reported skipped.
- 2026-09-16 — temporary docs-only PR [#16](https://github.com/DevAnuhas/duplexd/pull/16): the [docs job](https://github.com/DevAnuhas/duplexd/actions/runs/35059064162/job/104675351128) passed, `changes` passed, and `checks` reported skipped. The PR was closed without merge.
- 2026-09-16 — a fresh clone of the pushed branch under Node `24.21.0`, with no `.env` or application environment variables, passed frozen install, lint, typecheck, test, and build. Local `pnpm lint:links` also passed.
- 2026-09-18 — P01: with Turbo removed, `pnpm test` runs the 41 classifier tests and `pnpm typecheck` checks the surviving TypeScript. Both were verified to fail on a deliberately broken assertion, a broken classifier routing rule, an ESLint violation, and an introduced type error, and to pass again on revert. Evidence is in PR [#30](https://github.com/DevAnuhas/duplexd/pull/30).
