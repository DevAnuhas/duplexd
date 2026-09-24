# Engineering

Setup, verification, CI, and releases. This file owns supported commands and actual verification evidence. Every command below is executable today, including running the app.

## Toolchain

- Node `24.21.0` (`.node-version`) and pnpm `12.4.2` (including its Corepack integrity hash in `package.json`). Use `corepack enable` or install that exact pnpm version.
- TypeScript `6.0.3`, ESLint `10.10.0`, typescript-eslint `8.70.0`, Prettier `3.9.6`, and Vitest `5.0.1`.
- Markdown links are checked by `markdown-link-check` `3.15.0` through `pnpm lint:links`.
- Python 3.12 and `uv` for `agent/`.
- `pnpm install --frozen-lockfile` locally and in CI. Exact pins, one committed lockfile.

## Layout

```
apps/workspace/   the Next.js app: workspace UI now, /v1 control API in P05
agent/             the deployable, data-driven Pipecat runtime
scripts/          classify-docs-only.sh, the CI path classifier
tests/            the classifier's suite, run by the root Vitest runner
docs/             documentation and the decision trail
```

`apps/workspace` is the only pnpm workspace package. Root scripts run the root target and then the package, so a check cannot pass at root while ignoring the app.

### The Python agent

`agent/` is a Python 3.12 project managed by `uv`, outside the pnpm workspace. It has its own `pyproject.toml` and `uv.lock`, no entry in `pnpm-workspace.yaml`, and no pnpm wrapper. Pipecat is pinned at `1.11.0`; the spike remains separate as the provider-upgrade regression test.

Install and run its complete local gate with:

```bash
uv sync --frozen --directory agent
uv run --directory agent ruff check .
uv run --directory agent mypy duplexd_agent tests
uv run --directory agent pytest -q
docker build agent/
```

The Python toolchain has its own `agent` CI job and `uv` cache, independent of the pnpm job. Two toolchains in one repository is a decision, not an accident; the path classifier routes documentation-only changes away from both.

#### Local call stub

The committed stub is synthetic and serves both the future P05 config shape and a signature-verifying customer webhook:

```bash
uv run --directory agent config-stub
DUPLEXD_ALLOW_LOCAL_WEBHOOKS=1 OPENAI_API_KEY=... \
  uv run --directory agent bot -t webrtc
```

Use the runner body `{"callId":"stub-call","apiBase":"http://127.0.0.1:8791","agentToken":"stub-agent-token"}`. Port `8791` deliberately differs from the spike webhook on `8787`, so both regression surfaces can run together. The local-webhook flag is off by default and only the exact value `1` enables non-global customer webhook addresses; startup logs a warning when it is enabled. It does not enable redirects. Platform `apiBase` is supplied by duplexd and is not subject to the customer-webhook egress rule.

The config response uses camelCase consistently. Required keys are `assistantId`, `voice`, `instructions`, `accentStyle`, `waitingBehavior`, `backendModel`, `backendInstructions`, `serverUrl`, `serverSecret`, `tools`, `webhookTimeoutSecs`, `functionCallTimeoutSecs`, and `delegationTimeoutSecs`. The webhook timeout must be lower than both other timeouts so the customer receives the runtime's structured failure before Pipecat cancels the function or delegation.

Reported event names are `bot_speech_started`, `bot_speech_stopped`, `tool_started`, `tool_finished`, `delegation_created`, `transcript_user`, `transcript_assistant`, and `interruption`. Tool events carry the tool name and invocation id; the terminal event additionally carries outcome, duration, and optional status/error category. Completion reasons are `client_disconnected`, `pipeline_error`, and `idle_timeout`.

Those are the unchanged Integration shapes. The negotiated Sandbox protocol adds owner registration, one-time Practice configuration, independent control/watchdog tasks, actual readiness barriers, sequenced ACKs and a completion watermark. Its bounded reporter retains unacknowledged events and explicitly records loss/truncation; it does not claim all speech was captured. Apply additive migration `0007_famous_iron_man` before rolling out the new handlers/runtime; retain the ledger and handlers during rollback/drain. Sandbox dispatch, join and presence run when the deployment is configured for a provider and answer 503 when it is not — see [ADR 015](decisions/015-server-configured-sandbox-execution.md) and `sandbox/provider.ts`. [Wire contract, budgets and safe polling](architecture/sandbox-protocol.md).

#### Provider and deployment verification

Unit and integration tests use injected HTTP seams and do not claim to be a provider call. A real call requires `OPENAI_API_KEY`; absence is a blocked live-path check, not a passing fixture. Configure the `duplexd-agent-secrets` Pipecat Cloud secret set from a local file containing `OPENAI_API_KEY` and `DUPLEXD_PLATFORM_CREDENTIAL`, then deploy manually:

```bash
cd agent
uv run pipecat cloud secrets set duplexd-agent-secrets --file .env --skip
uv run pipecat cloud deploy
```

CI builds the image but never pushes or deploys it. `pcc-deploy.toml` keeps zero warm agents and a finite `max_agents` cost guard. A cold-start figure must come from a real `min_agents = 0` start; without Pipecat Cloud credentials it is blocked, never estimated.

Keep deployed agents above DEBUG logging. Pipecat logs backend system instructions at DEBUG; those instructions are customer content even though they are not credentials.

## Verification

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm lint:links
```

All commands require no environment variables, no database, and no Docker.

What each one actually does at this commit — stated plainly, because a command that reports green while running nothing is worse than one that fails:

| Command                                             | What it runs                                                                                                                      | Real coverage |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `pnpm format:check`                                 | Prettier over repository TypeScript, JavaScript, JSON, CSS, and YAML sources; generated artifacts and lockfiles are ignored       | yes           |
| `pnpm lint`                                         | `bash -n` over the classifier script, ESLint over the root files, then ESLint over `apps/workspace` — all with `--max-warnings=0` | yes           |
| `pnpm typecheck`                                    | `tsc --noEmit` over the root `tests/**`, then over `apps/workspace`                                                               | yes           |
| `pnpm test`                                         | `vitest run` for the 41 classifier tests, then the `apps/workspace` suite                                                         | yes           |
| `pnpm build`                                        | The production Next.js build of `apps/workspace`. **Runs with no database** — see below.                                          | yes           |
| `pnpm lint:links`                                   | `markdown-link-check` over every Markdown file                                                                                    | yes           |
| `uv run --directory agent ruff check .`             | Ruff over runtime and tests                                                                                                       | yes           |
| `uv run --directory agent mypy duplexd_agent tests` | Strict Python typecheck                                                                                                           | yes           |
| `uv run --directory agent pytest -q`                | Agent unit and integration suite                                                                                                  | yes           |
| `docker build agent/`                               | Deployable agent image build, without push                                                                                        | yes           |

### Why Turbo is gone

Turborepo was removed in P01. With every workspace package deleted, `turbo run test` and `turbo run lint` resolved to an empty task graph: Turbo reported `Running <task> in 0 packages`, `WARNING No tasks were executed`, and **exited 0** without running the `//#test:scripts` and `//#lint:root` root tasks. The classifier tests and root ESLint would have silently stopped running while both commands still reported success.

The alternatives were worse. An empty `packages: []`, or no workspace file at all, made Turbo hard-error on the `//#` root tasks. Single-package mode worked only with the root tasks removed and the scripts renamed to avoid `turbo run test` re-entering the root `test` script, which is Turbo wrapping exactly one command behind an indirection.

So the root scripts call `vitest`, `eslint`, and `tsc` directly. `package.json` alone shows why the classifier tests run.

P02 added the first package since, and widened each root script rather than reintroducing Turbo: `lint`, `typecheck` and `test` each run their root target and then `pnpm --filter workspace`. One package does not need a task graph, and the wiring stays legible in `package.json`. Turbo becomes worth reconsidering when a second package gives it a real dependency edge to order.

### The database

**A Neon branch per developer is the documented default, and any PostgreSQL 17 or newer works.** `DATABASE_URL` is a connection string and nothing in the app special-cases what answers it. `docker-compose.yml` was deleted in P01 and is not restored.

`DATABASE_URL` is never defaulted. An unset or empty value aborts with an error naming the variable, because libpq-based clients treat an empty connection string as "use the defaults" and connect to whatever PostgreSQL is listening locally — which is how the wrong database gets migrated.

```bash
cp .env.example apps/workspace/.env.local # fill five app variables and the sweep token
pnpm db:generate               # after changing src/db/schema.ts
pnpm db:migrate                # apply committed migrations; idempotent
pnpm dev                       # the workspace app
```

**The test suite refuses to wipe the database your `.env.local` names.** `test/migrations.test.ts` proves migrations apply from a genuinely empty schema, so it drops and recreates `public` — and the test environment fills an unset `DATABASE_URL` from `apps/workspace/.env.local`, the file the running app uses. A bare `pnpm test` therefore used to destroy your own development data with no warning. `dropAllSchemas()` now refuses when the two name the same host and database, and the refusal tells you which database it declined to touch:

```bash
DATABASE_URL=<scratch> pnpm test        # the usual answer: a throwaway branch
DUPLEXD_ALLOW_DESTRUCTIVE_TESTS=1 pnpm test   # yes, wipe the one .env.local names
```

The guard never fires in CI, where the database is disposable and starts empty, and it has nothing to compare against in a fresh clone. Only one situation changes: pointing the destructive suite at your own development database now takes a deliberate opt-out instead of an absent-minded command. It compares host and database rather than the raw connection string, because Neon serves the same database on both the direct and `-pooler` hostnames.

Migrations are generated by Drizzle and committed; they are never hand-edited. A correction is a new migration, because an edited one has already run somewhere. Preview and production ordering is in [DEPLOYMENT.md](DEPLOYMENT.md). Every migration must be safe for both the previous code and the next: additive first, destructive cleanup in a later deploy. This is a reviewed convention, not an enforced check, and it is what keeps rollback viable.

The Sandbox foundation migration is additive apart from allowing
`calls.agent_token_hash` to be null for a pre-dispatch reservation. Integration
creation still writes the hash in the same insert, and agent authentication
rejects a null digest. Existing calls retain `source=integration` and
`channel=browser`. Operational rollback disables/ignores the internal Sandbox
routes and leaves the additive columns/tables in place; it does not drop them.

Sandbox prepare is intentionally not a provider check. It may create a frozen
call/attempt/slot without minting an agent token, calling Pipecat or returning a
join credential; start, join and presence do that work, and on a deployment with
no provider configuration they return `sandbox_execution_disabled` instead. The authenticated sweep expires never-dispatched reservations, advances durable Sandbox deadlines, and — on a configured deployment — terminates unresolved provider sessions through the transport's private-key stop. Explicitly injected tests exercise dispatch, registration/config ownership, encrypted joins and exact-resource cleanup without network calls; `sandbox-execution-routes.test.ts` drives the composed instance through the browser routes with only `fetch` faked, which is what proves the configuration actually reaches the transport. The additive lifecycle migration adds attempt state and `sandbox_sessions`; operational rollback retains these records and handlers rather than clearing unresolved slots. A fixture is still not cleanup evidence: only a session read reporting an end time with a completion status marks a resource confirmed stopped. [Server protocol and A04 handoff](architecture/sandbox-protocol.md).

### Running the app

The Sandbox Pipecat transport is still exercised in tests with injected fake HTTP only, and it still reads no environment itself. `sandbox/provider.ts` supplies its configuration and its browser-media verifier; unknown media retains the exact session for reconciliation rather than returning a join credential. Source contracts and remaining live checks are in the [Sandbox protocol](architecture/sandbox-protocol.md#disconnected-pipecat-transport-contract). Safe attempt projections include server time and persisted readiness, and report `execution: "enabled"` exactly when the routes would dispatch.

#### Workspace Sandbox preparation

Open **Assistants → Create assistant → Riley sample**, then create the assistant through the normal form. The **Assistant** tab puts name, backend model, voice, speaking style, and instructions first; connection and tools follow. Open **Talk** for a Practice call using sample data. Assistant and Talk share an in-tab draft of conversation, voice, model and tool fields. Choose **Saved configuration** or **Unsaved conversation preview** in **Practice settings and sample responses**. Preview never saves the assistant; name and connection URL edits remain available when returning to Assistant but are excluded from preview. Newly entered credentials are cleared on route change and must be saved before leaving the form. Switching Assistant, Talk, and Calls raises no dialog; leaving those routes with edits opens one in-app discard choice. The assistant's **Calls** tab queries only that assistant's records within the signed-in account; global Calls remains in the sidebar.

Sandbox validates configuration and sample coverage using the existing Practice compiler. When an assistant has Riley's exact tool schema and no saved samples, the UI offers the fictional Riley pack for that test snapshot; it does not overwrite saved samples. Review the sample results and choose the default, unavailable, bounded-delay or controlled-failure scenario. An unavailable scenario uses explicitly authored overrides, with visible default fallback for other tools. Author default results and named overrides as bounded JSON in **Sample responses**. Blank defaults are missing; JSON `null` is an explicit authored result. Tool name or input-schema changes require an explicit sample review; description-only changes preserve the mapping fingerprint. **Save sample mappings** writes only mappings with their sample revision, separately from **Save changes** in Configure. Mappings for unsaved tools can be previewed, but must wait for an explicit assistant save before being persisted.

Revision conflicts keep the local draft. **Fetch latest saved version** reads the new baseline without overwriting edits; **Keep my edits** explicitly keeps locally changed fields and fills untouched fields from that baseline. Edited sample packs remain whole during rebase. **Discard edits** opens an in-app confirmation before discarding. Drafts live only in this tab and are never written to browser storage. Internal links leaving the assistant require **Discard and leave** when there are unsaved edits. In browsers with cancelable Navigation API traversal, Back and Forward use the same in-app choice. Hard reload and tab close use the browser's unload warning. Editing is locked while reservation status is unknown, a preparation is pending, or an unresolved reservation exists.

**Check microphone** requests audio only after a click, measures local input for at most five seconds after acquisition, then releases all tracks. Permission prompts time out after twenty seconds; a stream granted after cancellation is immediately stopped. **Play test sound** generates a short local tone. Neither check records or sends audio. Navigation, tab hiding and explicit cancellation release local audio. A successful local check is not agent readiness.

**Start practice call** is one gesture. It opens microphone capture and playback first, before creating the immutable, authenticated reservation through the existing Sandbox API, then dispatches without a second click when execution is enabled. A long permission prompt therefore cannot consume the thirty-second reservation window. Duplicate clicks and uncertain-response retries retain one attempt identifier and controller proof in memory. Refresh does not start anything; another tab observes the existing reservation and can cancel it as the same user. Call records and Calls history label Practice and distinguish preparation cancellation/expiry from a voice ending.

Voice dispatch still runs only when the deployment is configured for a provider: the attempt projection reports `execution: "enabled"` from the same predicate the routes use. If disabled, the reservation remains a preparation record and local capture is released. No browser switch or committed fixture route enables execution. The SDK is dynamically loaded after local capture/output readiness. Caller-owned custom audio is passed into one Daily call object; SDK same-room reconnect is limited to twenty seconds per interruption and two recoveries, without another start or join. The controller, call bar, and right-side conversation panel live in the signed-in app shell, so moving between signed-in pages does not unmount the media session. End, auth loss, lease expiry, tab hiding and leaving the site stop local tracks/output immediately while the UI waits for authoritative resource release. **Switching tabs or fully covering the browser still ends the call** until hidden-tab presence and disconnect behavior are measured and made safe. Refresh cannot recover the original tab proof. Persisted readiness alone cannot make historical or stopped execution Connected.

Three budgets are sized against a real cold start rather than a warm one, because each was shorter than the work it waited on and ended healthy calls. Start waits `dispatchMs + 15s`, since the server may spend its whole provider budget before it even begins to settle. The presence lease is renewed the moment audio connects rather than one interval later, because the lease has been running since dispatch and a slow start has already spent much of it; that first renewal alone is not fail-closed, since the lease is still valid when it fires. On the agent side, protocol negotiation, registration and the configuration claim get `STARTUP_REQUEST_TIMEOUT_SECS`, while the repeating control poll keeps the short one.

The conversation panel renders only safe projected transcript/tool fields as speaker turns and separately labeled sample-tool cards; system events sit behind **Call activity**. The evidence controller retains loaded history on errors, reports record completeness separately from call outcome, and limits each poll to three pages and the browser display to 2,000 events/2 MiB. A display limit or lost/truncated/conflicting evidence is visibly labeled; selected sample HTTP status does not imply delivery or business success. Text renders literally, without HTML interpretation or raw tool arguments/results. The panel does not invent a voice waveform or mark a call ended without the agent's report.

#### Reviewing Practice calls

**Calls** filters by Integration or Sandbox source, then Practice mode within Sandbox. Account dashboard call counts and their links cover Integration only; Practice tests remain visible in Calls and the assistant's Calls tab. Sandbox history uses its stored lifecycle and evidence ledger, while Integration retains its own stale-call interpretation. The two sources never borrow each other's failure rules. An archived assistant's history remains available through global Calls and the direct call URL.

The Sandbox call detail contains a durable **Review** section: saved or preview configuration, frozen scenario kind, agent readiness, reported tool outcomes, evidence completeness and the safe projected timeline. A reservation that never reached voice says **No voice execution**. The historical timeline is a read-only query and refreshes during the reporting grace window; it does not advance the Sandbox lifecycle. Tool results marked delivered are reported delivery outcomes, not real business success. The same review opens from Practice through an account- and assistant-scoped `?review=<callId>` link. An invalid review ID falls back to ordinary Practice. **Test again** opens current Practice settings with a projected scenario and never starts a call; named sample overrides are not restored. If the prior call used an unsaved preview, Practice says when it has fallen back to saved configuration.

After a voice call reaches a terminal state, an account member can record four checklist answers (`Met`, `Needs work`, or `Not checked`) and a note. These are human judgments, displayed separately from the agent evidence. Other members can read them but only the author can edit their own. Edits use a revision check; a conflict requires an explicit choice to load the latest version or keep unsaved edits before another save. Notes are normalized, bounded to 2,000 Unicode code points, and rendered as text. No observation is accepted for an Integration call, a running call, or a preparation that never reached voice. Additive migration `0008_volatile_lily_hollister` stores these rows; deleting an author retains the note as **Former member**.

The browser adapter requires a secure context, `getUserMedia`, Web Audio and the Daily SDK's supported WebRTC browser APIs. Local synthetic Chromium acceptance does not establish a supported real-media browser matrix; Safari/Firefox/native capture/autoplay and real-room testing remain release checks. Provider dispatch/cleanup proof, real audible disclosure/interruption, live evidence reconciliation and complete Stage A review remain blocked or unverified. Preparation consumes no voice/model usage. The existing public integration API is unchanged; a workspace session is not a customer API key.

#### Riley demo seed

The fastest way to inspect a Riley configuration is:

```bash
pnpm seed:riley
```

This validates and prints a **disconnected demo preview**, without connecting to
a database or provider. It includes separate voice/backend instructions and one
generic `get_property_information` tool for fictional parking, checkout, and
amenities examples. It contains no tenant identity, real property facts, guest
data, phone numbers, Vapi credentials, or webhook secret. Voice/model values are
starting points, not a claim of live compatibility.

To create it in duplexd, sign up normally first. Configure `DATABASE_URL` for the
intended local or staging duplexd database in `apps/workspace/.env.local`, apply
the migrations, and use that signup's email:

```bash
pnpm --filter workspace exec node --env-file=.env.local --experimental-strip-types src/db/migrate.ts
pnpm seed:riley --apply --owner-email you@example.com
pnpm dev
```

The seed automatically loads `apps/workspace/.env.local`; exported environment
variables take precedence. It prints the new assistant ID and editor path. It
does not create users, accounts, API keys, or calls. Run it only against the
database you intend to change; the script cannot infer the environment from a
connection string. Reruns preserve the existing record, including manual edits,
connections, and archived state. Edit the assistant through the UI; an archived
seed is not silently recreated or restored. An archived rerun reports
`already_exists_archived` with no editor link, because archived assistants are
not accessible in the editor. `--owner-email` requires `--apply`; preview does not
look up or select a workspace.

**This is configuration preparation, not a working Boring Host integration.**
The saved assistant intentionally has no server URL or signing secret, so call
creation is blocked. Its tool schema is a generic fictional example, not a
contract for Boring Host or another customer. No Boring Host/Vapi access or
mutation is performed by the seed.

Before a real connected demo, a separately authorized customer adapter must
verify the duplexd signature and bind the call to the customer's own authorized
context. Configure its URL and a separate customer-owned signing secret through
the assistant editor only after that contract exists. This seed does not add a
customer adapter or a call-launch client.

For an audio-only synthetic demo today, the [local call stub](#local-call-stub)
uses the Pipecat WebRTC runner and synthetic data, independently of this seeded
workspace assistant. It is not evidence of Boring Host acceptance. A seed also
does not satisfy P06's separate requirement to create an assistant through the UI.

#### Production server

```bash
pnpm build                                     # production build
pnpm --filter workspace start                  # runs .next/standalone/apps/workspace/server.js
```

`next start` does **not** work with `output: 'standalone'`; the build emits its own server and the `start` script runs it. Vercel does not consume this artifact—it remains solely because the test suite boots a real production Next server to verify startup validation, Better Auth proxy behavior, origin and CSRF rejection, session cookie attributes, and rate limiting. `BETTER_AUTH_URL` must be set to the origin you are serving from. The cookie test configures the public HTTPS origin while the local listener stays on HTTP, matching production TLS termination; it checks cookie flags, not TLS transport.

`pnpm build` deliberately needs **no** database: the database and auth clients are constructed on first use rather than at module import, and every page that reads the database is dynamic. A build that required `DATABASE_URL` would make every deploy depend on the database being reachable from the builder. CI proves this on every pull request by running the build step with no database environment.

Run the Python agent with `uv run --directory agent bot` and a Pipecat runner transport argument.

### The assistant's webhook secret, and what the database layer will not log

The secret a customer gives an assistant is theirs, held on the platform's
behalf. It is encrypted with AES-256-GCM before it reaches an insert, and the
read paths return a **boolean** saying whether one is set rather than the value
— so nothing that renders a page could leak it even by accident.

One consequence is less obvious and worth knowing before adding a query.
Drizzle builds a failed query's error as `Failed query: <sql>` followed by
`params: <bound values>`, which puts every parameter into whatever catches it.
`src/db/redact.ts` wraps the client `getDb()` returns and strips those values
from **three** places, because a value that survives in any one of them reaches
a log:

- `.message`, which is where Drizzle writes them.
- `.stack`, because V8 formats it once and caches it, so anything that read it
  before redaction would have kept the original. It is repaired by splicing the
  redacted message over the original's span rather than by matching a pattern —
  a boundary guessed from content is guessed from _customer free text_, and an
  `instructions` field containing a wrapped sentence is indistinguishable from a
  stack frame.
- **Own enumerable properties.** `DrizzleQueryError` does not only build its
  message from the parameters, it keeps them as `query` and `params`. Those are
  what `util.inspect` prints, which is what `console.error(err)` does, which is
  what Next's logger does with a caught error. Redacting the first two alone was
  cosmetic against the field frameworks actually emit. The rule is an allowlist:
  `query` is kept because it is parameterised SQL with no values in it, and
  anything a future version attaches is blanked without anyone having to notice
  it appeared.

Coverage is by route as well as by field. `await`, `.catch()`, `.finally()` and
`db.query` — Drizzle's relational API, which `getDb()` enables by passing
`{ schema }` — all reach the client by different paths, and the last three
originally bypassed the wrapper entirely because they are not `then` on the
proxy. Nothing in the repository uses them today, which is exactly why they
would have been missed.

It sits on the client rather than on each call site deliberately: Better Auth's
adapter receives the same client and runs its own queries through it, and could
never opt into a per-call-site wrapper. **If you add a database call, you
inherit this for free; if you add a second client, you do not.** See
[#33](https://github.com/DevAnuhas/duplexd/issues/33).

## CI

`.github/workflows/ci.yml` runs its CI jobs for ready-for-review pull requests and pushes to `main`. A draft creation or draft update can create a GitHub Actions workflow record, because GitHub Actions cannot filter draft state at the trigger level, but every CI job is skipped and no dependencies are installed or checks run. Marking a draft ready runs CI; later pushes while it remains ready run CI again at the current head. Its `changes` job runs the repository's merge-base-aware path classifier. Code changes run the Node checks in `checks` and the independent frozen Python lint, typecheck, tests, and Docker build in `agent`; documentation-only changes run `pnpm lint:links` in `docs`. Unselected jobs report skipped rather than disappearing, so branch protection can require the stable check names recorded in [WORKFLOW.md](WORKFLOW.md).

The classifier is covered by 41 tests in `tests/classify-docs-only.test.ts`, run by `pnpm test`. They are the reason a change to the routing rules cannot land silently.

The `checks` job runs a PostgreSQL 18 service container and sets `DATABASE_URL` to it, so the database-backed tests — cross-account isolation, migrate-from-empty, encryption at rest — **execute** in the one place that gates a merge. They may skip locally when no database is configured; they may not skip in CI, and the suite fails if they do. A skip that reports green is the defect, not the missing database.

## Environment variables

`.env.example` lists every variable the app reads and nothing else. Copy it to `apps/workspace/.env.local`, which is gitignored and is where Next loads it for local workspace commands.

**Five app-wide runtime variables are required, and serverless registration throws naming any that is missing.** That check lives in `src/instrumentation.ts`, which Next runs at function initialization rather than during `next build`, so a build still needs no database. Validating at first use would be too late: `ASSISTANT_SECRET_KEY` is otherwise read only when a customer saves a webhook secret. On the retired long-lived server, throwing was insufficient because Next kept a healthy-looking port bound, so the process explicitly exited. Vercel functions have no durable application socket; propagation is the fail-closed mechanism, and the live production-server matrix proves every route class returns 500 while a complete environment serves. Nothing is defaulted.

- `DATABASE_URL` — PostgreSQL connection string
- `BETTER_AUTH_SECRET` — session signing secret
- `BETTER_AUTH_URL` — the public origin the app is served from
- `ASSISTANT_SECRET_KEY` — 32 bytes hex, encrypts assistants' webhook secrets at rest
- `PIPECAT_API_KEY` — server-side credential for starting the deployed Pipecat agent

`CALL_SWEEP_TOKEN` is required **for the sweep route**, not for the app as a whole. The endpoint reads it on every request and refuses uniformly when it is absent, while logging the missing variable server-side. It is deliberately outside startup validation: scheduler failure delays persistence only, because customer reads derive stale state independently; taking down unrelated routes would turn safe degradation into an outage.

One more is **optional**, and it is the one an operator can set wrongly:

- `ALLOW_LOOPBACK_SERVER_URL` — set to the literal `true` to let an assistant's server URL point at loopback (`http://localhost`, `127.0.0.1`, `[::1]`) for local development.

It must **not** join the required list above: unset means off, which is the safe behaviour. A test asserts that absent-safety rather than merely describing it.

**Setting it in a hosted environment opens the private-network exception in production.** A webhook is called from the platform's own network, so a loopback target there is not the customer's service but ours. See [OPERATIONS.md](OPERATIONS.md#webhook-targets) for what the rule protects.

Never commit values.

## Releases

Production deploys are staged by `.github/workflows/deploy-production.yml` after a push to `main`, through the GitHub `production` environment. The first real run remains blocked on the owner setup in [DEPLOYMENT.md](DEPLOYMENT.md).

## Evidence

- 2026-09-16 — PR [#15](https://github.com/DevAnuhas/duplexd/pull/15) code path: [CI run 35058950023](https://github.com/DevAnuhas/duplexd/actions/runs/35058950023) passed `changes` and `checks`; `docs` reported skipped.
- 2026-09-16 — temporary docs-only PR [#16](https://github.com/DevAnuhas/duplexd/pull/16): the [docs job](https://github.com/DevAnuhas/duplexd/actions/runs/35059064162/job/104675351128) passed, `changes` passed, and `checks` reported skipped. The PR was closed without merge.
- 2026-09-16 — a fresh clone of the pushed branch under Node `24.21.0`, with no `.env` or application environment variables, passed frozen install, lint, typecheck, test, and build. Local `pnpm lint:links` also passed.
- 2026-09-18 — P01: with Turbo removed, `pnpm test` runs the 41 classifier tests and `pnpm typecheck` checks the surviving TypeScript. Both were verified to fail on a deliberately broken assertion, a broken classifier routing rule, an ESLint violation, and an introduced type error, and to pass again on revert. Evidence is in PR [#30](https://github.com/DevAnuhas/duplexd/pull/30).
