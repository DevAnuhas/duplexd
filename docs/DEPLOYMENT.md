# Deployment

Canonical deployment runbook for the workspace/control API. Preview deployments and the staged production workflow have run successfully. The checklist below describes the required dashboard configuration; verify its current values before a new release or live acceptance run.

## Platform shape

- The Next.js workspace and `/v1` control API deploy to Vercel as serverless functions.
- Postgres is the existing Neon project `duplexd-platform` (`autumn-frog-71299404`).
- Every pull-request preview gets an isolated Neon branch through the Neon-Managed Vercel integration and migrates that branch during its build.
- Production builds are staged without a domain, migrated from a GitHub `production` environment, then promoted. Vercel's Git deployment for `main` is disabled in `apps/workspace/vercel.json` so it cannot bypass that order.
- Pipecat Cloud remains the agent host and is deployed separately.

## Local development database

Each active implementation worktree uses its assigned Neon development branch; never reuse `main` or another agent's branch. `apps/workspace/.env.local` is gitignored and belongs to the worktree, not the repository. Removing a worktree removes that file too, so a replacement must be obtained through the project owner or approved secret-management channel rather than reconstructed from logs, another checkout, or a guessed local database.

Before a migration fixture drops schemas, connect read-only and inspect Neon's `project_id`, `branch_id`, and `endpoint_id` settings. Proceed only when all three identify the assigned project and branch. Never print or paste the connection string into a command result, PR, artifact, or issue.

## Owner dashboard state and actions

1. The Vercel project already has Root Directory `apps/workspace`. Keep the framework set to Next.js and clear the stale `outputDirectory=public` override.
2. In Neon Console, open Integrations → Vercel and install the Marketplace **Neon-Managed Integration** using **Link Existing Neon Account**. Do not install the Vercel-Managed/Native integration alongside it.
3. Connect the `duplexd` Vercel project to `duplexd-platform`, selecting the intended database and role. One Neon project maps to one Vercel project.
4. Enable **Automatically delete obsolete Neon branches**. Renaming a Git or Neon branch breaks the name matching used for cleanup.
5. Remove any manually configured preview `DATABASE_URL` before connecting the integration; a conflicting project-level value can defeat isolation. Confirm a preview receives both its own `DATABASE_URL` and `DATABASE_URL_UNPOOLED` from the integration.
6. Scope the application variables below separately for Preview and Production. Previews use synthetic credentials and data only.
7. Add the GitHub production-environment and scheduler secrets below. Keep production-environment approval enabled if the repository policy requires human production approval.

The successful preview builds and production promotions prove those deployment paths ran. They do not prove every environment variable, provider image or spend limit needed for [Stage A acceptance](https://github.com/DevAnuhas/duplexd/issues/66); read those back before the live run.

## Vercel application environment

| Variable                    | Scope                                                                    | Purpose                                                                     |
| --------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `DATABASE_URL`              | Preview: integration-injected; Production: pooled production URL         | Runtime database connection                                                 |
| `DATABASE_URL_UNPOOLED`     | Preview: integration-injected                                            | Exact connection preflighted and migrated during a preview build            |
| `NEON_PRODUCTION_BRANCH_ID` | Preview                                                                  | Production branch ID; the preview preflight refuses an equal branch         |
| `VERCEL_GIT_COMMIT_REF`     | Preview, supplied by Vercel                                              | Git branch name; preview migration refuses `main`                           |
| `BETTER_AUTH_SECRET`        | Preview and Production, different values                                 | Session signing                                                             |
| `BETTER_AUTH_URL`           | Production, matching the public origin; leave **unset** on Preview       | Auth callback/cookie origin                                                 |
| `ASSISTANT_SECRET_KEY`      | Preview and Production, different values                                 | AES-256-GCM key for webhook secrets                                         |
| `PIPECAT_API_KEY`           | Preview and Production                                                   | Starts the Pipecat agent; previews must not receive a customer credential   |
| `PIPECAT_PRIVATE_API_KEY`   | Preview and Production — **all-or-nothing with the three below**         | Reads and terminates provider sessions; must differ from `PIPECAT_API_KEY`  |
| `PIPECAT_ORGANIZATION_ID`   | Preview and Production                                                   | Organization **UUID**, not the CLI namespace slug                           |
| `PIPECAT_SERVICE_ID`        | Preview and Production                                                   | `duplexd-agent` service UUID                                                |
| `PIPECAT_DEPLOYMENT_ID`     | Preview and Production                                                   | Active deployment UUID; re-set it after every `pipecat cloud deploy`        |
| `SANDBOX_AGENT_API_BASE`    | Local development only — **optional**                                    | HTTPS origin the agent calls back on when it differs from `BETTER_AUTH_URL` |
| `RESEND_API_KEY`            | Preview and Production, different values — **optional**                  | Sends the password reset email                                              |
| `EMAIL_FROM`                | Preview and Production — **optional**, e.g. `duplexd <auth@example.com>` | From-address on the password reset email                                    |

### Why the Sandbox provider variables are all-or-nothing

`PIPECAT_API_KEY`, `PIPECAT_PRIVATE_API_KEY`, `PIPECAT_ORGANIZATION_ID`, `PIPECAT_SERVICE_ID` and `PIPECAT_DEPLOYMENT_ID` are what enable Sandbox voice calls ([ADR 015](decisions/015-server-configured-sandbox-execution.md)). `readSandboxProviderEnvironment()` in `src/db/env.ts` reads all five or returns `null`; on `null` the composed lifecycle has no transport and Sandbox start, join and presence answer 503, which is also what the workspace shows the tenant.

A partial configuration is a mistake rather than a half-enabled feature, and the failure it would otherwise cause is the expensive one: a start that reaches the provider, creates a paid session, and then cannot prove the session is ours — so it can neither be joined nor terminated.

Read the three UUIDs from the private API rather than the dashboard, because the dashboard shows names:

```
GET https://api.pipecat.daily.co/v1/agents                 # organizationId, service id
GET https://api.pipecat.daily.co/v1/agents/duplexd-agent   # activeDeploymentId
```

`PIPECAT_ORGANIZATION` — the value a Pipecat CLI profile holds — is a **namespace slug, not a UUID**. Putting it in `PIPECAT_ORGANIZATION_ID` is refused at read time, because every ownership comparison against a provider session would otherwise fail and every session would look like someone else's.

`PIPECAT_DEPLOYMENT_ID` changes on every deploy. A stale value does not fail loudly: starts still succeed, and then reconciliation refuses to recognise the sessions they created.

### Why the email variables are optional

`RESEND_API_KEY` and `EMAIL_FROM` are the only variables here that gate a feature rather than the application. They are deliberately **not** among the five startup prerequisites validated in `src/instrumentation.ts`: a deployment with no email configured must still boot and serve everything else.

They are read together, by `emailDeliveryConfigured()` in `src/db/env.ts`. With both set, password reset works. With either missing:

- the "Forgot your password?" link is not rendered on `/sign-in`, and
- `/forgot-password` and `/reset-password` return 404.

That is the honest failure: a reset link that cannot send is the worst dead button in the product, because the person pressing it is already locked out. Only the boolean crosses to the client — the key and the from-address stay on the server.

The from-address domain must be verified in Resend, or delivery fails silently from the sender's point of view. The reset token lasts **one hour** and is single-use (Better Auth's `resetPasswordTokenExpiresIn` default, `3600` seconds).

### Why `BETTER_AUTH_URL` is unset on Preview

A preview origin cannot be configured ahead of time: every pull request gets a generated domain, so no value in the Preview scope matches the origin a reviewer opens. Setting one is worse than leaving it blank, because this variable decides the cookie domain and the `__Secure-` prefix — a wrong origin signs in and then silently fails to keep the session.

A preview answers on **two** hostnames that both legitimately serve it: the stable branch URL (`VERCEL_BRANCH_URL`) and the per-deployment URL (`VERCEL_URL`). Vercel's dashboard and pull-request comments link the per-deployment one, so that is the host a reviewer actually opens.

Better Auth compares the request's `Origin` against its base URL, so pinning either host rejects the other with `403 Invalid origin`. Left unset on a preview, `resolveAuthBaseUrl()` therefore returns Better Auth's `DynamicBaseURLConfig` — `protocol: 'https'`, `allowedHosts` listing both hosts exactly, `fallback` the branch URL. The base URL is resolved per request but **allowlisted**: the request may pick between origins this deployment already knows about, and cannot name one. `allowedHosts` never contains a wildcard; `*.vercel.app` would match every deployment on the platform.

`requireAuthUrl()` still returns a single origin, preferring the branch URL because it survives a redeploy. It is for callers that must hand one address to something else — the agent's `apiBase` is the only one.

Both are **preview-only**. Production missing `BETTER_AUTH_URL` fails closed rather than minting cookies for a `vercel.app` domain instead of the real one, and keeps a plain string base URL so no request header participates in the auth decision. Both halves are mutation-proven in `apps/workspace/test/env.test.ts`: dropping the preview guard turns the production tests red, and narrowing to the branch host alone turns the two-host tests red.

### Sweep-only environment

`CALL_SWEEP_TOKEN` is required for `POST /v1/internal/sweep` in Preview and Production, with different values. It is deliberately not one of the five app-wide startup prerequisites. If omitted, the sweep endpoint refuses every request and logs that the variable is missing; stale rows are not persisted, but workspace and customer routes continue serving and read-time projection still presents stale calls correctly.

The preview migration preflight runs on `DATABASE_URL_UNPOOLED`, the same connection it migrates. It refuses missing/blank variables, `main` or a missing Git ref, mismatched pooled and unpooled endpoints, non-Neon targets, the wrong Neon project, and a branch ID equal to `NEON_PRODUCTION_BRANCH_ID`. This proves a preview cannot migrate the production branch. It does not prove the integration injected the URL; only a real preview deployment can settle that.

CI covers the preflight's identity decision with injected branch identities. Its local PostgreSQL service cannot expose Neon's `neon.project_id` and `neon.branch_id`, so the real-Neon proof names itself as **NOT RUN** rather than disappearing into a green count. With the approved per-worktree `.env.local` present, run the live proof from the repository root:

```sh
pnpm --filter workspace exec vitest run test/vercel-deployment.test.ts -t "real Neon preview identity gate"
```

The test setup resolves `.env.local` through the shared environment helper, preferring `apps/workspace/.env.local` and retaining the repository-root fallback used by older worktrees.

## GitHub secrets

The `production` environment needs:

| Secret              | Authority and source                                                                                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VERCEL_TOKEN`      | Create a Vercel account token with only the authority needed to deploy and promote this project. It is a deployment credential; store it only as a GitHub environment secret. |
| `VERCEL_ORG_ID`     | Vercel team/account ID for the project                                                                                                                                        |
| `VERCEL_PROJECT_ID` | Vercel project ID                                                                                                                                                             |
| `DATABASE_URL`      | Unpooled production Neon URL used only by the migration step                                                                                                                  |

The scheduled sweep workflow needs repository or environment secrets:

| Secret             | Purpose                                              |
| ------------------ | ---------------------------------------------------- |
| `WORKSPACE_URL`    | Production workspace origin, without a trailing path |
| `CALL_SWEEP_TOKEN` | Same production token configured in Vercel           |

The token is sent only in the `Authorization: Bearer` header. Never place it in a URL or query parameter; those are routinely retained in proxy access logs.

## Production ordering and recovery

`.github/workflows/deploy-production.yml` restores the ordering that Fly's `release_command` previously supplied:

0. A behavioural context guard refuses any Git ref other than `refs/heads/main` or any target other than `production` before deploy or database work.
1. `vercel deploy --prod --skip-domain` builds a production deployment without assigning the production domain.
2. `pnpm --filter workspace db:migrate` applies committed migrations and reports the migration-ledger count before, after, and applied.
3. `vercel promote` assigns the already-built deployment to production only after migration succeeds.

If promotion fails after migration, rerun the workflow. Drizzle's ledger makes the second migration a measured no-op and the workflow reaches promotion again. A migration must still be safe for the previous application version as well as the next: add schema first, switch code later, and remove old schema in a later deployment. That convention is not mechanically enforced, but it is what keeps rollback safe.

`apps/workspace/vercel.json` disables the Git integration's `main` deployment. If that setting is removed or ignored, Vercel can silently deploy `main` outside the staged workflow and restore the schema-ordering race. Confirm the dashboard shows no separate Git-triggered production deployment after the first run.

## Preview branch limits and data trigger

The Neon Free plan has a hard limit of 10 branches; creation fails rather than queues or bills. Four branches existed when this runbook was written, leaving roughly six preview slots. Storage is 0.5 GB per project, shared by the parent and branch deltas. Free databases scale to zero after five minutes and that cannot be disabled, so acceptance timing must measure database wake-up together with the Pipecat cold start.

A preview branch is a copy-on-write clone of its parent, including data. Current records are synthetic. **Before the first real customer call is recorded**, either change previews to use a seeded non-customer branch or enable preview access protection. A public preview containing copied transcripts is unacceptable even if the database branch itself is isolated.

## External sweep

GitHub calls `POST /v1/internal/sweep` every five minutes. The endpoint is idempotent; running it twice changes nothing on the second call. Read paths derive staleness independently, so a late or disabled scheduler delays persistence only—the UI and read API still present stale calls honestly.

GitHub automatically disables scheduled workflows after 60 days without repository activity. Treat that as a persistence/operations alert, not a correctness failure: re-enable the workflow, rotate the token if exposure is suspected, and run it manually once.

The sweeper is not load-bearing for read correctness, but it is load-bearing for storage. Without persistence, dead rows remain inside the partial `active` and `starting` indexes indefinitely; those indexes can grow while the UI still looks correct and eventually consume Neon's 0.5 GB project allowance. A scheduler that has failed for a long time is therefore an operational incident, not harmless background lag.

## Verification still blocked on owner actions

- A real preview receives integration-injected URLs for its own Neon branch and migrates that branch.
- A branch-cap failure produces a failed preview without any database migration.
- The first production workflow builds with `--skip-domain`, migrates, and promotes successfully on the owner's Vercel plan.
- Vercel honors `git.deploymentEnabled.main=false`, so a push to `main` does not create a second automatic production deployment outside the staged workflow.
- The scheduled GitHub workflow successfully invokes the production sweep endpoint with its configured secrets.
- Vercel sets `x-real-ip` to the client address at the deployed edge.
- Clearing the stale output-directory override makes the actual Vercel deployment boot.

Do not replace these checks with local server results; they test dashboard and edge behavior that local code cannot reproduce.
