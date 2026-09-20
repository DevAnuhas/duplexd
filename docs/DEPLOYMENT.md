# Deployment

Canonical deployment runbook for the workspace/control API. The repository contains the Vercel configuration and GitHub workflows; the dashboard setup below is still an owner action and has **not** been performed or verified by this change.

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

Writing these steps does not prove the dashboards are configured. The first preview database injection and first production deployment remain blocked until the owner performs them and reads the resulting environment/deployment back.

## Vercel application environment

| Variable                    | Scope                                                            | Purpose                                                                   |
| --------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `DATABASE_URL`              | Preview: integration-injected; Production: pooled production URL | Runtime database connection                                               |
| `DATABASE_URL_UNPOOLED`     | Preview: integration-injected                                    | Exact connection preflighted and migrated during a preview build          |
| `NEON_PRODUCTION_BRANCH_ID` | Preview                                                          | Production branch ID; the preview preflight refuses an equal branch       |
| `VERCEL_GIT_COMMIT_REF`     | Preview, supplied by Vercel                                      | Git branch name; preview migration refuses `main`                         |
| `BETTER_AUTH_SECRET`        | Preview and Production, different values                         | Session signing                                                           |
| `BETTER_AUTH_URL`           | Production, matching the public origin; leave **unset** on Preview | Auth callback/cookie origin                                               |
| `ASSISTANT_SECRET_KEY`      | Preview and Production, different values                         | AES-256-GCM key for webhook secrets                                       |
| `PIPECAT_API_KEY`           | Preview and Production                                           | Starts the Pipecat agent; previews must not receive a customer credential |

### Why `BETTER_AUTH_URL` is unset on Preview

A preview origin cannot be configured ahead of time: every pull request gets a generated domain, so no value in the Preview scope matches the origin a reviewer opens. Setting one is worse than leaving it blank, because this variable decides the cookie domain and the `__Secure-` prefix — a wrong origin signs in and then silently fails to keep the session.

Left unset on a preview, `requireAuthUrl()` builds the origin from `VERCEL_BRANCH_URL`, which Vercel injects per deployment. That is not the request's `Host` header, so the deployment still states its own identity rather than inferring it from traffic; the branch URL is used rather than the per-deployment `VERCEL_URL` because it survives a redeploy of the same pull request, and because `VERCEL_URL` does not work under Standard Deployment Protection.

The fallback is **preview-only**. Production missing `BETTER_AUTH_URL` still fails closed rather than minting cookies for a `vercel.app` domain instead of the real one. Both halves are mutation-proven in `apps/workspace/test/env.test.ts`.

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
