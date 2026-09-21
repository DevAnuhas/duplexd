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

## Accepted replacement

None of #60's acceptance claims have been proven yet. Local tests cannot close
that gap. The accepted replacement is a purpose-built disposable image under
`scripts/provider-contract/probe`; it does not import or modify the production
agent. It exposes only the six deterministic case behaviors and exact-session
callbacks needed above.

The request-scoped run ID, case, boot ID, callback URL, and 256-bit callback
secret are acceptable only because the image is separately released, runs on
the existing no-traffic service for this bounded exercise, and is rolled back
immediately. The collector rejects a callback unless its HMAC and exact
run/case/boot/session correlation match. No provider secret set or temporary
private API key is created.

`run.mjs` is the single operator program. It uses the authenticated official
Pipecat CLI for build/deploy, exact-session stop, status and pinned-build
rollback. Direct HTTP is limited to public-key start and exact machine-readable
readbacks that the CLI does not provide. It also creates one runtime-only,
mode-600 browser witness page using the actual room-scoped Daily token. The
witness records only join/ejection booleans and timestamps; the token, room URL,
callback secrets, raw session IDs and provider responses never enter evidence.

## Offline and live commands

Offline checks do not contact or mutate the provider:

```sh
node scripts/provider-contract/run.mjs plan
node --test scripts/provider-contract/test/run.test.mjs
cd scripts/provider-contract/probe
PYTHONPATH=. ../../../agent/.venv/bin/python -m pytest test_bot.py -q
```

The live command remains blocked until the coordinator releases an exact
committed head. At release time the operator supplies existing credentials with
shell tracing disabled:

```sh
set +x
export PROVIDER_PROOF_LIVE_RELEASE=stage-a-disposable-probe-release
export PROVIDER_PROOF_RUN_ID=...
export PROVIDER_PROOF_EVIDENCE_PATH=/absolute/mode-600/path.json
export PIPECAT_API_KEY=...          # existing public start key
export PIPECAT_OPERATOR_TOKEN=...  # existing CLI/OAuth operator token
export PIPECAT_ORGANIZATION=...
node scripts/provider-contract/run.mjs live
```

The runner fails closed unless the baseline is exact and no session is active.
It deploys the probe with min/max 0/1 and no secret set, applies and reads back
the 600-second provider ceiling before case 1, performs at most six serial
starts, never retries an ambiguous start, and caps the operator envelope at 720
seconds per case and calculated usage at 72 billed minutes. For the two ceiling
cases it requires both agent and browser ejection plus independently stable
provider ended-state/resource metrics. A second exact-session stop must report
`404` and is accepted only after that reconciliation.

On success, failure, or signal, cleanup stops every known exact session, uses
the official CLI to redeploy the pinned baseline, and requires authenticated
readback of the exact build/digest, min/max 0/3, `duplexd-agent-secrets`, absent
duration override, zero active sessions, zero private keys, and absent
`duplexd-provider-proof`. If cleanup cannot prove those facts, the result stays
blocked and the safer 600-second containment remains visible.

## Merge rule

**A01 and A03 remain blocked until the released live exercise passes.** Offline
tests prove only dispatch and safety logic. After live evidence and strict
rollback are verified, remove the disposable Dockerfile, probe, runner and tests
before merging; retain only this runbook plus sanitized evidence. If any case
cannot prove the contract, keep #60 open and return to technical design.
