# External references

How an implementing agent uses outside code and documentation. This exists because "borrow the pattern from project X" is not actionable unless the agent knows where to look, what it may copy, and what it must prove.

## Default: read, do not clone

Agents fetch source directly. Cloning a reference repository into this workspace risks its files being committed here, and a stale local clone silently misleads the next agent.

```bash
# Read a specific file at a pinned commit
curl -s https://raw.githubusercontent.com/OWNER/REPO/COMMIT_SHA/path/to/file.ts

# List a directory
curl -s https://api.github.com/repos/OWNER/REPO/contents/src?ref=COMMIT_SHA
```

Always pin a commit SHA, never `main`. A reference read from a moving branch cannot be re-verified later, and the file you cite may not be the file the next agent sees.

If a reference genuinely requires a local checkout — running its test suite, or tracing behavior across many files — clone it **outside this repository** and state in the PR that you did.

## Before copying any code

Copying is different from reading. Check, in order:

1. **License.** Read the actual `LICENSE` file at the pinned commit. Do not trust a search result, a README badge, or a previous agent's note — licenses change, and monorepos often carry different terms per directory. Some repositories exclude specific directories from their main license.
2. **Provenance.** Confirm the file is the project's own work and not vendored third-party code under other terms.
3. **Attribution.** Permissive licenses still have conditions. Record the source, commit SHA, and license in the file header or the relevant ADR.

If the license is unclear, restricted, or excludes the directory you want, **reimplement the idea instead of copying the code**, and say so in the PR.

## What is worth taking

Take structural patterns: how a boundary is drawn, how a lifecycle is sequenced, how a contract is shaped, how a failure is recovered. Those transfer.

Do not take a reference's stack choices, dependency set, or file layout because it exists. Another project's decisions answer another project's constraints. A pattern that survives contact with `ARCHITECTURE.md` is worth adopting; one that requires bending an invariant is not.

An external project's capability is evidence that something is possible — never evidence that it is secure, performant, or production-ready. Reference code frequently omits authorization, tenancy, and recovery precisely because a demo does not need them. The invariants in `AGENTS.md` still apply to anything adapted from it.

## Recording the decision

When an external source materially shapes an implementation, record it in `docs/decisions/` with the repository, pinned commit, license, what was taken, and what was deliberately left behind.

When a source is merely reference reading, mention it in the PR description. It does not need an ADR.

## Where candidate references come from

`docs/research/LANDSCAPE.md` holds the pre-decision survey of existing projects. Treat those as leads to verify, not conclusions — that record predates current decisions and its claims were not re-checked against later releases.

An agent may also find its own references. Nothing here restricts research; these rules govern what gets copied into the repository, not what may be read.
