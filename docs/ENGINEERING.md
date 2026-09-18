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
apps/workspace/   the Next.js app: workspace UI now, /v1 control API in P05
scripts/          classify-docs-only.sh, the CI path classifier
tests/            the classifier's suite, run by the root Vitest runner
spikes/pipecat-gate/   the passing Pipecat gate (Python, uv), kept as a regression test
docs/             documentation and the decision trail
```

`apps/workspace` is the only pnpm workspace package. Root scripts run the root target and then the package, so a check cannot pass at root while ignoring the app.

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
| `pnpm lint` | `bash -n` over the classifier script, ESLint over the root files, then ESLint over `apps/workspace` — all with `--max-warnings=0` | yes |
| `pnpm typecheck` | `tsc --noEmit` over the root `tests/**`, then over `apps/workspace` | yes |
| `pnpm test` | `vitest run` for the 41 classifier tests, then the `apps/workspace` suite | yes |
| `pnpm build` | The production Next.js build of `apps/workspace`. **Runs with no database** — see below. | yes |
| `pnpm lint:links` | `markdown-link-check` over every Markdown file | yes |

### Why Turbo is gone

Turborepo was removed in P01. With every workspace package deleted, `turbo run test` and `turbo run lint` resolved to an empty task graph: Turbo reported `Running <task> in 0 packages`, `WARNING No tasks were executed`, and **exited 0** without running the `//#test:scripts` and `//#lint:root` root tasks. The classifier tests and root ESLint would have silently stopped running while both commands still reported success.

The alternatives were worse. An empty `packages: []`, or no workspace file at all, made Turbo hard-error on the `//#` root tasks. Single-package mode worked only with the root tasks removed and the scripts renamed to avoid `turbo run test` re-entering the root `test` script, which is Turbo wrapping exactly one command behind an indirection.

So the root scripts call `vitest`, `eslint`, and `tsc` directly. `package.json` alone shows why the classifier tests run.

P02 added the first package since, and widened each root script rather than reintroducing Turbo: `lint`, `typecheck` and `test` each run their root target and then `pnpm --filter workspace`. One package does not need a task graph, and the wiring stays legible in `package.json`. Turbo becomes worth reconsidering when a second package gives it a real dependency edge to order.

### The database

**A Neon branch per developer is the documented default, and any PostgreSQL 17 or newer works.** `DATABASE_URL` is a connection string and nothing in the app special-cases what answers it. `docker-compose.yml` was deleted in P01 and is not restored.

`DATABASE_URL` is never defaulted. An unset or empty value aborts with an error naming the variable, because libpq-based clients treat an empty connection string as "use the defaults" and connect to whatever PostgreSQL is listening locally — which is how the wrong database gets migrated.

```bash
cp .env.example .env.local     # then fill in the three variables
pnpm db:generate               # after changing src/db/schema.ts
pnpm db:migrate                # apply committed migrations; idempotent
pnpm dev                       # the workspace app
```

Migrations are generated by Drizzle and committed; they are never hand-edited. A correction is a new migration, because an edited one has already run somewhere. In production they run as a Fly release command, before any machine serves traffic.

### Running the app

```bash
pnpm build && pnpm --filter workspace start   # production build, what a deploy runs
```

`pnpm build` deliberately needs **no** database: the database and auth clients are constructed on first use rather than at module import, and every page that reads the database is dynamic. A build that required `DATABASE_URL` would make every deploy depend on the database being reachable from the builder. CI proves this on every pull request by running the build step with no database environment.

*The Python agent lands in P04: `uv run --directory agent bot`.*

## CI

`.github/workflows/ci.yml` always starts for pull requests and pushes to `main`. Its `changes` job runs the repository's merge-base-aware path classifier. Code changes run frozen install, lint, typecheck, test, and build in `checks`; documentation-only changes run `pnpm lint:links` in `docs`. The unselected job reports skipped rather than disappearing, so later branch protection can require the stable check names recorded in [WORKFLOW.md](WORKFLOW.md).

The classifier is covered by 41 tests in `tests/classify-docs-only.test.ts`, run by `pnpm test`. They are the reason a change to the routing rules cannot land silently.

The `checks` job runs a PostgreSQL 18 service container and sets `DATABASE_URL` to it, so the database-backed tests — cross-account isolation, migrate-from-empty, encryption at rest — **execute** in the one place that gates a merge. They may skip locally when no database is configured; they may not skip in CI, and the suite fails if they do. A skip that reports green is the defect, not the missing database.

## Environment variables

`.env.example` lists every variable the app reads and nothing else. Copy it to `.env.local`, which is gitignored. The app fails at server start naming any that is missing — it never falls back to a default, because a defaulted database URL connects somewhere unintended and a defaulted encryption key is the same as no encryption.

- `DATABASE_URL` — PostgreSQL connection string
- `BETTER_AUTH_SECRET` — session signing secret
- `ASSISTANT_SECRET_KEY` — 32 bytes hex, encrypts assistants' webhook secrets at rest

Never commit values.

## Releases

None yet. When the workspace app is deployable, releases are tagged from `main` and deployed per [OPERATIONS.md](OPERATIONS.md) with human approval for production.

## Evidence

- 2026-09-16 — PR [#15](https://github.com/DevAnuhas/duplexd/pull/15) code path: [CI run 35058950023](https://github.com/DevAnuhas/duplexd/actions/runs/35058950023) passed `changes` and `checks`; `docs` reported skipped.
- 2026-09-16 — temporary docs-only PR [#16](https://github.com/DevAnuhas/duplexd/pull/16): the [docs job](https://github.com/DevAnuhas/duplexd/actions/runs/35059064162/job/104675351128) passed, `changes` passed, and `checks` reported skipped. The PR was closed without merge.
- 2026-09-16 — a fresh clone of the pushed branch under Node `24.21.0`, with no `.env` or application environment variables, passed frozen install, lint, typecheck, test, and build. Local `pnpm lint:links` also passed.
- 2026-09-18 — P01: with Turbo removed, `pnpm test` runs the 41 classifier tests and `pnpm typecheck` checks the surviving TypeScript. Both were verified to fail on a deliberately broken assertion, a broken classifier routing rule, an ESLint violation, and an introduced type error, and to pass again on revert. Evidence is in PR [#30](https://github.com/DevAnuhas/duplexd/pull/30).
