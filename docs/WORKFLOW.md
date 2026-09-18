# Workflow

Branching, issues, pull requests, and worktrees.

## Branch model

```text
feat/* --PR+squash--> main
```

`main` is the default branch and the only long-lived one. Every change enters through a pull request. Agents never push directly to `main` and never use `--admin` or `--no-verify`.

There is deliberately no `dev` branch. A second integration branch earns its place when `main` cannot be kept releasable. That does not apply yet.

## Environments

Environments are created when there is something to deploy. Until then, do not add environment configuration, promotion workflows, or deployment secrets. The intended shape is in `docs/OPERATIONS.md`.

## Issues

GitHub Issues is the work registry. There is no external tracker.

```bash
gh issue list --search "keywords"
gh issue view 12
gh issue create --title "..." --body-file issue.md
```

Work crossing two or more files gets an issue before implementation. Read-only questions and bounded investigations do not.

Issue bodies state the problem, desired outcome, constraints, and acceptance evidence. They link to the owning document rather than restating it, and do not dictate unverified implementation details; the implementing agent decides those.

Keep issue state truthful. Merged is not deployed. Close through `Closes #N` in the PR body, not by hand.

## Feature work

1. Create a worktree from current `main`:

   ```bash
   git worktree add ../duplexd-12 -b feat/12-short-slug
   ```

   Keep at most two worktrees with installed dependencies at a time.

2. Implement and verify. If behavior documented by a canonical file changes, update that file in the same PR.

3. Push and open a **draft** PR targeting `main`:

   ```bash
   gh pr create --draft --base main --title "type(scope): summary (#12)"
   ```

   Include `Closes #12` in the body. Keep it draft while the head is still changing.

4. When implementation is complete and locally verified, update from current `main` once, then mark ready exactly once:

   ```bash
   gh pr ready PR_NUMBER
   ```

   Do not toggle draft and ready or rerun checks to manufacture a green result. A post-ready push must earn a fresh run.

5. Squash-merge after required checks pass on the current head:

   ```bash
   gh pr merge PR_NUMBER --squash
   ```

6. Remove the worktree when merged or cancelled:

   ```bash
   git worktree remove ../duplexd-12
   ```

## PR contents

A pull request records what behavior changed, which checks actually ran and their results, a recorded live session for transport work, migration and rollback considerations, and any unresolved blockers.

An agent's success narrative is not a check result. A blocked check is not a pass.

## Commits

Format: `type(scope): summary`. Group by coherent change, not by file-count quota.

Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `build`, `ci`. Scope is the area touched, not a closed set: `workspace`, `api`, `agent`, `spike`, `repo`, or the ticket identifier for a repository-wide chore.

Pull request titles use the same format with the issue appended: `type(scope): summary (#N)`. This repository squash-merges with the PR title as the commit subject.

```text
feat(workspace): add assistant editor with tool-list validation (#26)
feat(api): issue and revoke API keys (#26)
docs(repo): record Pipecat as the voice runtime (#23)
```

Agents commit with the repository's configured Git identity. Do not change global Git identity or rewrite existing commits.

## Branch protection

**Not currently enforced.** Read the live configuration back before treating any protection as active. Until a ruleset exists, everything in this file is a convention agents follow, not a control the platform applies.

The intended configuration:

- Pull request required before merging; no direct pushes
- Force-push and deletion blocked
- Squash merge only, with branch deletion on merge
- Required status checks, once CI exists

## Required checks

CI reports these stable job names:

- `changes`
- `checks`

Both must be required when the repository ruleset is enabled. Requiring `changes` prevents a failed path detector from becoming an apparently successful skipped `checks` job. Requiring `checks` is safe for documentation-only pull requests because the workflow always starts and its job-level condition reports `checks` as skipped; this differs from a trigger-level path filter, where no check run exists and a required check remains pending.

Branch protection is not currently configured, and T01 does not change repository settings. Configure the ruleset to require pull requests, block force-push and deletion, allow squash merge only, and require both names above after CI is merged.

## Authorization

Agents may squash-merge a feature PR into `main` after required checks pass on its current head. Optional model review is advisory, never a merge gate.

Outbound calls to real numbers, production deployment, release publication, paid provisioning, and public publication require explicit human authorization. Create the PR and stop.
