# Documentation map

| Doc                                                                  | Purpose                                                                                |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| [AGENTS.md](../AGENTS.md)                                            | Agent entry point: working rules, invariants, task map, verification                   |
| [CONTEXT.md](../CONTEXT.md)                                          | What duplexd is and is not, direction, open questions, status                          |
| [ARCHITECTURE.md](../ARCHITECTURE.md)                                | Components, trust boundaries, call lifecycle, persistence                              |
| [architecture/sandbox-protocol.md](architecture/sandbox-protocol.md) | Gated server lifecycle, A04 protocol handoff, exact resource reconciliation            |
| [MILESTONE.md](MILESTONE.md)                                         | Current build target, sequence, acceptance evidence                                    |
| [ENGINEERING.md](ENGINEERING.md)                                     | Setup, tests, CI, data, releases                                                       |
| [WORKFLOW.md](WORKFLOW.md)                                           | Branching, issues, PRs, worktrees                                                      |
| [OPERATIONS.md](OPERATIONS.md)                                       | Hosting, environments, provisioning                                                    |
| [DEPLOYMENT.md](DEPLOYMENT.md)                                       | Vercel/Neon setup, environment scoping, migration ordering, blocked checks             |
| [REFERENCES.md](REFERENCES.md)                                       | Using external repos and code: pinning, licensing, attribution                         |
| [decisions/](decisions/)                                             | ADRs: accepted, proposed, superseded                                                   |
| [research/LANDSCAPE.md](research/LANDSCAPE.md)                       | Pre-decision survey of existing projects. Reference only, not authority                |
| [research/TRAYCER_EPIC_BRIEF.md](research/TRAYCER_EPIC_BRIEF.md)     | Prompt for the planning Epic that produced the retired milestone's tickets. Historical |

Start with `AGENTS.md`, then `CONTEXT.md` and `MILESTONE.md`. Read the rest when the task touches its surface.

One authority per concern: product scope in `CONTEXT.md`, boundaries in `ARCHITECTURE.md`, decisions in `decisions/`, procedures in `WORKFLOW.md` and `ENGINEERING.md`, current behavior in code and tests.

Implementation status: `apps/workspace` contains authentication, assistants, API keys, Practice voice, call history and the `/v1` control API; `agent/` contains the deployed Pipecat runtime. Preview and production deployments have run, while integrated Stage A acceptance remains open in [#66](https://github.com/DevAnuhas/duplexd/issues/66). See [DEPLOYMENT.md](DEPLOYMENT.md).
