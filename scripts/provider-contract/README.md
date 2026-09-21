# Pipecat provider-contract evidence

Issue [#60](https://github.com/DevAnuhas/duplexd/issues/60) is **blocked**.
This record distinguishes what the live attempts actually observed from the
contract they were intended to prove. It is not a fixture or a substitute for
live evidence.

## Intended acceptance contract

The proof must run at most six Pipecat sessions, serially, with no retry after
an ambiguous start. Each case must correlate the start response and runtime
registration by exact provider session ID; timestamp-based ownership guesses
are forbidden.

| Case                                       | Evidence required                                                                                                 |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Cold start                                 | Start response fields, exact runtime registration, and readiness inside the startup bound                         |
| Cancel before join                         | An exact-session stop and independent process and usage cessation                                                 |
| Lost start response, registration received | Stop only the exact session learned from registration; never retry start                                          |
| Lost start response, no registration       | No guessed stop; provider ceiling followed by zero active probe sessions                                          |
| Hung runtime                               | Effective room and token expiry/ejection for both participants, plus independent process and usage cessation      |
| Repeated stop                              | Both stops address the same session; a `404` counts only after exact-session ended-state and usage reconciliation |

Room ejection alone cannot prove stopped compute or billing. The proof must
also establish that unknown-start, no-registration, and hung-runtime paths have
a finite resource bound. The authorized envelope was concurrency one, a
600-second provider ceiling, a 720-second operator bound per case, no more than
six starts, and no more than 72 billed session-minutes total.

## What was observed

Four authorized runs were attempted on 2026-09-21. Every run stopped before
case 1, so none produced a session-level acceptance observation.

| Run ID                    | Last trustworthy observation                                                                                                                                                      |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stage-a-20260921-a01`    | Pre-session control-plane handling failed on the provider's split public/private key-list shape. Containment cleanup completed.                                                   |
| `stage-a-20260921-a01-r2` | Pre-session aggregate readback failed. Read-only diagnosis found real manifest/build response shapes that the discarded normalizer did not handle. Containment cleanup completed. |
| `stage-a-20260921-a01-r3` | Pre-session execution failed, but the sanitizer had discarded the operation identity. No more specific failure claim is supportable. Containment cleanup completed.               |
| `stage-a-20260921-a01-r4` | The fixed secret-safe stage was `probe_secret_set_create`. Containment cleanup completed.                                                                                         |

Across all four runs:

- provider sessions started: **0**;
- calculated billed session usage: **0 minutes**;
- acceptance cases completed: **0 of 6**;
- no call, audio, transcript, tenant, or customer data was involved.

After each attempt, authenticated readback verified the same strict baseline:

| Check                               | Verified value                                                            |
| ----------------------------------- | ------------------------------------------------------------------------- |
| Service                             | `duplexd-agent`                                                           |
| Build                               | `3010f496-fd84-4f39-a75c-c4a58a1bd922`                                    |
| Image digest                        | `sha256:032aa1f121bc91a22748c725966bfd21e6659daaf8b159d367fd6e0f7a745242` |
| Scaling                             | minimum 0, maximum 3                                                      |
| Secret set                          | `duplexd-agent-secrets`                                                   |
| Session-duration override           | absent                                                                    |
| Active sessions                     | 0                                                                         |
| Private API keys                    | 0                                                                         |
| `duplexd-provider-proof` secret set | absent                                                                    |

## Decision

None of #60's acceptance claims were proven. Local tests and synthetic fixtures
cannot close that gap, and adding probe activation, callbacks, collectors,
provider adapters, or fault modes to the production agent would create a
second platform rather than evidence. Those changes were removed.

**A01 is blocked, not passed. A03 remains blocked.** PR #67 references #60 and
must not close it.

Before any new implementation, the technical design must choose one of two
paths:

1. explicitly authorize a purpose-built, disposable, non-production probe
   image on the existing no-traffic test service, kept outside the production
   agent and limited to the six evidence cases; or
2. revise A03's lifecycle contract and #60 acceptance criteria to depend only
   on guarantees observable through official Pipecat surfaces.

Until that decision is accepted, there is no honest fifth run and no provider
contract implementation to merge.
