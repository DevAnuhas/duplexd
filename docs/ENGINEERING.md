# Engineering

Setup, verification, CI, and releases. This file owns supported commands and actual verification evidence. Until application code exists, every command below is intended, not verified.

## Toolchain

- Node `24.21.0` (`.node-version`), pnpm pinned in `package.json` `packageManager`. Use `corepack enable` or install the pinned version.
- Python 3.12+ and `uv` only for `examples/handler-python`.
- Docker for local PostgreSQL.
- `pnpm install --frozen-lockfile` locally and in CI. Exact pins, one committed lockfile.

## Intended layout

```
packages/contracts     Zod schemas, JSON Schema export, contract test suite
packages/core          session FSM, transcript, broker, provider adapters
packages/transports    webrtc, websocket-audio, twilio, sip
apps/server            Fastify server
apps/console           Vite + React
examples/handler-node  sample remote handler
examples/handler-python
```

Turborepo orders and caches build, lint, typecheck, and test. Packaging and anything touching the live provider are never cached.

## Local run

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

| Layer | What it proves | Command |
| --- | --- | --- |
| Contract tests | A handler implementation matches `PROTOCOL.md` | `pnpm --filter contracts test` and the Python equivalent |
| Core unit tests | Broker behavior against a scripted fake provider | `pnpm --filter core test` |
| Server tests | Session creation, auth, handler forwarding, persistence | `pnpm --filter server test` |
| Live session | The real provider accepts our session and delegation flow | manual, recorded, session id in the PR |

Aggregate contracts used by CI: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`. Do not invent substitutes.

A live session is required for any change to a provider adapter or transport. It is not cached, not automated in milestone 1, and its session id goes in the PR.

## Environment variables

Names only, in `.env.example`. Never commit values.

- `OPENAI_API_KEY`: server only
- `DATABASE_URL`
- `DUPLEXD_API_KEYS`: comma-separated consumer keys for local development; a real key store replaces this before hosting
- `HANDLER_URL`, `HANDLER_SECRET`: for running the example handlers against the local server

## CI

Intended: one workflow on pull requests and `main` running frozen install, lint, typecheck, test, and build on Linux. The exact check name is recorded in `docs/WORKFLOW.md` when it exists. Documentation-only changes run link validation only.

## Data

Drizzle migrations, generated with `pnpm db:generate`, committed, applied with `pnpm db:migrate`. No hand-written migrations. Local development uses docker compose Postgres. Hosted environments use Neon; see `docs/OPERATIONS.md`.

## Releases

None yet. When the server is deployable, releases are tagged from `main` and deployed per `docs/OPERATIONS.md` with human approval for production.

## Evidence

No checks have run. This section records observed results once they exist.
