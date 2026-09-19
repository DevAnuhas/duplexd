# Documentation map

| Doc | Purpose |
| --- | --- |
| [AGENTS.md](../AGENTS.md) | Agent entry point: working rules, invariants, task map, verification |
| [CONTEXT.md](../CONTEXT.md) | What duplexd is and is not, direction, open questions, status |
| [ARCHITECTURE.md](../ARCHITECTURE.md) | Components, trust boundaries, call lifecycle, persistence |
| [MILESTONE.md](MILESTONE.md) | Current build target, sequence, acceptance evidence |
| [ENGINEERING.md](ENGINEERING.md) | Setup, tests, CI, data, releases |
| [WORKFLOW.md](WORKFLOW.md) | Branching, issues, PRs, worktrees |
| [OPERATIONS.md](OPERATIONS.md) | Hosting, environments, provisioning |
| [REFERENCES.md](REFERENCES.md) | Using external repos and code: pinning, licensing, attribution |
| [decisions/](decisions/) | ADRs: accepted, proposed, superseded |
| [research/LANDSCAPE.md](research/LANDSCAPE.md) | Pre-decision survey of existing projects. Reference only, not authority |
| [research/TRAYCER_EPIC_BRIEF.md](research/TRAYCER_EPIC_BRIEF.md) | Prompt for the planning Epic that produced the retired milestone's tickets. Historical |

Start with `AGENTS.md`, then `CONTEXT.md` and `MILESTONE.md`. Read the rest when the task touches its surface.

One authority per concern: product scope in `CONTEXT.md`, boundaries in `ARCHITECTURE.md`, decisions in `decisions/`, procedures in `WORKFLOW.md` and `ENGINEERING.md`, current behavior in code and tests.

Implementation status: `apps/workspace` exists — a Next.js app with authentication and the full Drizzle schema. Assistants and API keys are the next ticket; the control API and agent come after. Also in the repository: the decision trail, the CI workflow and its path classifier, and the passing Pipecat gate at `spikes/pipecat-gate/`. Nothing is deployed.
