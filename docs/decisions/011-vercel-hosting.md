# 011: Vercel hosts the workspace and control API

Status: accepted
Date: 2026-09-20

## Context

ADR 010 moved live calls into a separately deployed Pipecat agent and left the workspace/control-API hosting question open. The remaining Next.js application handles short requests and no longer needs the long-lived sockets that drove ADR 005's Fly decision.

The deployment must also keep preview migrations away from production, preserve migrate-before-serve ordering in production, and run stale-call persistence without owning a permanent process.

## Decision

The workspace and control API deploy to Vercel serverless functions. This answers ADR 010's open hosting question and supersedes ADR 005 for the platform layer only; Pipecat Cloud remains the agent host.

The Neon-Managed Vercel integration creates an isolated Neon branch for each pull-request preview. A preview preflights and migrates its own branch during build. Production is deployed from GitHub Actions: build with `--skip-domain`, migrate through the protected production environment, then promote the already-built deployment. The stale-call sweep is an authenticated, idempotent HTTP endpoint invoked by GitHub Actions, while reads derive stale state independently.

Preview isolation carries a data condition: branches clone their parent's data. The data is synthetic today. **Before the first real customer call is recorded, previews must either use a seeded non-customer branch or be access-protected.** A public preview must never expose copied customer call records or transcripts.

## Alternatives

**Keep Fly for the platform.** Rejected: the app no longer owns call media or live sockets, so a permanent Node server and release image add operations without buying a needed capability.

**Let Vercel's Git integration deploy production directly.** Rejected: Vercel would assign the successful build before a separately gated migration, briefly serving new code against old schema.

**Never migrate previews.** Rejected once previews received isolated database branches: new code would run against its parent branch's old schema, a combination production never uses.

**Give previews a Neon management credential to prove URL provenance.** Rejected: compromise of a public preview would gain branch-management authority in a project with a hard branch cap. The preflight checks the safety property directly—the connected branch is not production—without broadening preview authority.

## Consequences

- Dashboard setup remains an owner action; repository configuration alone does not establish a working deployment.
- The Neon Free plan has a hard 10-branch cap, 0.5 GB project-wide storage, and mandatory scale-to-zero after five minutes. Acceptance timing must measure database wake-up together with agent cold start.
- The Neon-Managed and Vercel-Managed integrations cannot coexist for one project, and branch renames break automatic cleanup's name matching.
- Production migrations must be backwards-compatible with the previous code version because rollback can outlive promotion ordering.
- GitHub scheduled workflows can be disabled after repository inactivity; delayed sweeps affect persistence, not read correctness.
- Vercel edge behavior and Neon integration injection require real-deployment verification and remain blocked until setup is performed.
- ADR 005 remains historical and still explains the retired long-lived server; it no longer governs the workspace/control API.

See [the deployment runbook](../DEPLOYMENT.md) for setup, variables, recovery, and blocked verification.
