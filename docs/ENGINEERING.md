# Engineering

Setup, verification, CI, and releases. This file owns supported commands and actual verification evidence. The workspace commands are executable; application startup remains planned until the tickets named below land.

## Toolchain

- Node `24.21.0` (`.node-version`) and pnpm `12.4.2` (including its Corepack integrity hash in `package.json`). Use `corepack enable` or install that exact pnpm version.
- Turborepo `2.10.13`, TypeScript `6.0.3`, ESLint `10.10.0`, typescript-eslint `8.70.0`, Prettier `3.9.6`, and Vitest `5.0.1`.
- Markdown links are checked by `markdown-link-check` `3.15.0` through `pnpm lint:links`.
- Python 3.12+ and `uv` only for `examples/handler-python`.
- Docker for local PostgreSQL.
- `pnpm install --frozen-lockfile` locally and in CI. Exact pins, one committed lockfile.

## Layout

```
packages/contracts          @duplexd/contracts wire schemas, fixtures, signing, NDJSON, and conformance
packages/core               @duplexd/core placeholder; depends on contracts
packages/transports/webrtc  @duplexd/transport-webrtc placeholder
apps/server                 @duplexd/server placeholder
apps/console                @duplexd/console placeholder
examples/handler-node       handler-node placeholder
examples/handler-python     README placeholder only; T11 owns its toolchain
```

Turborepo orders and caches build, lint, typecheck, and test. `@duplexd/core` imports `@duplexd/contracts` through its package export so the dependency edge is real. Packaging and anything touching the live provider are never cached. Package `typecheck` and `build` scripts both use `tsc -b`: TypeScript `6.0.3` accepts `--noEmit` for an isolated composite project, but a cold referenced build rejects it with `TS6310` because the referenced contracts project may not disable emit.

## Workspace verification

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm lint:links
```

All commands require no environment variables. `pnpm dev` exits with a T06 message; `pnpm db:generate` and `pnpm db:migrate` exit with a T07 message until those tickets land.

## Planned application run

```bash
cp .env.example .env         # set OPENAI_API_KEY and DATABASE_URL
docker compose up -d postgres
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm dev                     # server + console
pnpm --filter handler-node dev
```

Open the console, start a call. The Twilio path is not part of milestone 1; when it exists it needs a public tunnel (`ngrok` or `cloudflared`) for the TwiML and media stream endpoints.

## Verification layers

| Layer           | What it proves                                            | Command                                                           |
| --------------- | --------------------------------------------------------- | ----------------------------------------------------------------- |
| Contract tests  | A handler implementation matches `PROTOCOL.md`            | `pnpm --filter @duplexd/contracts test` and the Python equivalent |
| Core unit tests | Broker behavior against a scripted fake provider          | `pnpm --filter @duplexd/core test`                                |
| Server tests    | Session creation, auth, handler forwarding, persistence   | `pnpm --filter @duplexd/server test`                              |
| Live session    | The real provider accepts our session and delegation flow | manual, recorded, session id in the PR                            |

Aggregate contracts used by CI: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`. Do not invent substitutes.

Contracts-specific verification:

```bash
pnpm --filter @duplexd/contracts build
pnpm --filter @duplexd/contracts schema:check
pnpm --filter @duplexd/contracts test
node packages/contracts/dist/src/conformance/cli.js --url http://127.0.0.1:<port>/delegations --secret synthetic-test-secret
```

The build regenerates committed `packages/contracts/schema/*.json` and `constants.json`. `schema:check` generates into a separate temporary directory and compares the complete file set and bytes. CI additionally rejects any tracked or untracked schema change left by the build.

The repository command above executes the built file named by the package's `duplexd-conformance` bin mapping. Once the package is installed, consumers invoke the same file as `duplexd-conformance`.

A live session is required for any change to a provider adapter or transport. It is not cached, not automated in milestone 1, and its session id goes in the PR.

## Environment variables

Names only, in `.env.example`. Never commit values.

- `OPENAI_API_KEY`: server only
- `DATABASE_URL`
- `DUPLEXD_API_KEYS`: comma-separated consumer keys for local development; a real key store replaces this before hosting
- `HANDLER_URL`, `HANDLER_SECRET`: for running the example handlers against the local server

## CI

`.github/workflows/ci.yml` always starts for pull requests and pushes to `main`. Its `changes` job runs the repository's merge-base-aware path classifier. Code changes run frozen install, lint, typecheck, test, and build in `checks`; documentation-only changes run `pnpm lint:links` in `docs`. The unselected job reports skipped rather than disappearing, so later branch protection can require the stable check names recorded in [WORKFLOW.md](WORKFLOW.md).

## Data

Drizzle migrations, generated with `pnpm db:generate`, committed, applied with `pnpm db:migrate`. No hand-written migrations. Local development uses docker compose Postgres. Hosted environments use Neon; see `docs/OPERATIONS.md`.

## Releases

None yet. When the server is deployable, releases are tagged from `main` and deployed per `docs/OPERATIONS.md` with human approval for production.

## Evidence

- 2026-09-16 — PR [#15](https://github.com/DevAnuhas/duplexd/pull/15) code path: [CI run 35058950023](https://github.com/DevAnuhas/duplexd/actions/runs/35058950023) passed `changes` and `checks`; `docs` reported skipped.
- 2026-09-16 — temporary docs-only PR [#16](https://github.com/DevAnuhas/duplexd/pull/16): the [docs job](https://github.com/DevAnuhas/duplexd/actions/runs/35059064162/job/104675351128) passed, `changes` passed, and `checks` reported skipped. The PR was closed without merge.
- 2026-09-16 — a fresh clone of the pushed branch under Node `24.21.0`, with no `.env` or application environment variables, passed frozen install, lint, typecheck, test, and build. Local `pnpm lint:links` also passed.
- 2026-09-16 — `docker compose up -d --wait postgres` reached healthy. A host-side query through the `.env.example` URL returned PostgreSQL `17.6`, current user `duplexd`, and current database `duplexd`; the Compose service was then stopped.
