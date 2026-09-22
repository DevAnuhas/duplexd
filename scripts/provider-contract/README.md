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

| Case                                       | Evidence required                                                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Cold start                                 | Start response fields, exact runtime registration, and readiness inside the startup bound                          |
| Cancel before join                         | An exact private-key session stop and independent terminal/resource evidence                                       |
| Lost start response, registration received | Stop only the exact session learned from registration; never retry start                                           |
| Lost start response, no registration       | No guessed stop; provider ceiling followed by zero active probe sessions                                           |
| Hung runtime                               | Effective room and token expiry/ejection for both participants, plus independent terminal/resource evidence        |
| Repeated stop                              | Both stops address the same session; a `404` counts only with independent exact-session terminal/resource evidence |

Room ejection alone cannot prove stopped compute or billing. The proof must
also establish that unknown-start, no-registration, and hung-runtime paths have
a finite resource bound. The authorized envelope was concurrency one, a
600-second provider ceiling, a 720-second operator bound per case, no more than
six starts, and no more than 72 reserved session-minutes total. Each dispatch
reserves its full 12-minute allowance before its start intent and POST. An
ambiguous start consumes that allowance; recovery never refunds, resets or
redispatches it. Reservations are conservative admission accounting, not
observed usage or proof that a provider bound actually worked.

## What was observed

Nine authorized runs were attempted on 2026-09-21. The first eight stopped
before a session-level acceptance observation. The final run started one
`cold_start` session but produced no durable case evidence.

| Run ID                                | Last trustworthy observation                                                                                                                                                                                                                                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stage-a-20260921-a01`                | Pre-session control-plane handling failed on the provider's split public/private key-list shape. Containment cleanup completed.                                                                                                                                                                                                       |
| `stage-a-20260921-a01-r2`             | Pre-session aggregate readback failed. Read-only diagnosis found real manifest/build response shapes that the discarded normalizer did not handle. Containment cleanup completed.                                                                                                                                                     |
| `stage-a-20260921-a01-r3`             | Pre-session execution failed, but the sanitizer had discarded the operation identity. No more specific failure claim is supportable. Containment cleanup completed.                                                                                                                                                                   |
| `stage-a-20260921-a01-r4`             | The fixed secret-safe stage was `probe_secret_set_create`. Containment cleanup completed.                                                                                                                                                                                                                                             |
| `stage-a-20260921-a01-probe-1`        | The disposable image built successfully in Pipecat Cloud and the deployment was created, but the CLI exited during deployment readiness monitoring. The discarded raw output prevents a narrower claim. Containment cleanup completed. See [`live-evidence.json`](live-evidence.json).                                                |
| `stage-a-20260921-a01-probe-2`        | The CLI reported success, but exact manifest reconciliation refused the deployment because same-service update semantics inherited `duplexd-agent-secrets`. No secret value was accessed or logged. Cleanup restored the exact baseline. See [`live-evidence.json`](live-evidence.json).                                              |
| `stage-a-20260921-a01-temp-service-1` | The isolated service passed exact build/digest/min0/max1/empty-secret readback, then stopped before case 1 because the repository's Pipecat CLI 0.4.4 did not support the duration operation used by the runner. Cleanup deleted the probe service and production remained unchanged. See [`live-evidence.json`](live-evidence.json). |
| `stage-a-20260921-a01-temp-service-2` | The supported CLI deployed with the duration bound, but the runner omitted the authoritative nested duration field during readback. No session started; cleanup deleted the probe service and production remained unchanged.                                                                                                          |
| `stage-a-20260921-a01-temp-service-3` | One `cold_start` session started. Runner cleanup overwrote the case stage and deleted volatile collector state, so registration and stable billing are unknowable. Post-exit containment stopped the exact session and deleted the probe service; production remained exact. See [`live-evidence.json`](live-evidence.json).          |

Across all nine runs:

- provider sessions started: **1**;
- stable billed usage: **unknown**; the recorded zero is unaccumulated and is
  not evidence of zero billing;
- acceptance cases completed: **0 of 6**;
- no call, audio, transcript, tenant, or customer data was involved.

After each attempt and required containment, authenticated readback verified
the same strict baseline:

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
the temporary `duplexd-provider-proof` service for this bounded exercise, and
that service is deleted immediately. The production `duplexd-agent` service is
read-only throughout. The collector rejects a callback unless its HMAC and exact
run/case/boot/session correlation match. No provider secret set or temporary
private API key is created.

`run.mjs` is the single operator program. It uses the authenticated official
Pipecat CLI through an isolated `pipecatcloud==0.6.0` uv overlay for
build/deploy and service deletion. Public-key start and operator control-plane
readbacks remain distinct from server-only private-key session management.
Exact GET/DELETE use the documented
`https://api.pipecat.daily.co/v1/agents/{agentName}/sessions/{sessionId}`
route with `PIPECAT_PRIVATE_API_KEY`, never an OAuth or public-key substitute.
GET must match the retained session, service, organization and deployment IDs,
including the resource-metrics session ID. DELETE must acknowledge that exact
session. A successful DELETE is not terminal/resource proof; an independent
GET must establish it. The private scoped active list must return HTTP 200,
`total_count: 0` and an empty `sessions` array for the retained deployment.
It also creates a unique runtime-only, mode-600 browser witness page per joined case using
the actual room-scoped Daily token. The witness records only join/ejection
booleans and timestamps.

The runner now writes a durable run directory selected by the operator. The
directory must be new, outside every Git worktree, and outside the operating
system's temporary directory. It is created mode 700 and contains:

- `events.ndjson`: append-only, synced, sanitized observations;
- `recovery.json`: mode-600 private recovery state with exact provider IDs;
- `summary.json`: an atomic projection that can be regenerated from the
  journal and recovery state.

The private checkpoint is the only local file allowed to contain exact session,
build, deployment, service, organization and private-key inventory identifiers. It never contains an
API key, OAuth token, callback secret or URL, Daily credential, provider response
body, log, audio, or customer data. The journal and summary use salted stable
references. A single-writer lock prevents live and recovery processes from
mutating the same run concurrently; a dead process's lock may be taken over.
Stale-lock replacement is serialized by an exclusive `writer.takeover`
directory, and release removes only the caller's own lock. If a process dies
during that brief takeover, recovery fails closed: remove only the empty
`writer.takeover` directory after independently confirming that every runner
and recovery process for this run has stopped. Never clear it under an active writer.

## Offline and live commands

Offline checks do not contact or mutate the provider:

```sh
node scripts/provider-contract/run.mjs plan
node --test scripts/provider-contract/test/*.test.mjs
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
export PIPECAT_API_KEY=...          # existing public start key
export PIPECAT_PRIVATE_API_KEY=...  # separately authorized existing server management key
export PIPECAT_OPERATOR_TOKEN=...  # existing CLI/OAuth operator token
export PIPECAT_ORGANIZATION=...
node scripts/provider-contract/run.mjs live --run-dir \
  "$HOME/.local/state/duplexd/provider-proof/$PROVIDER_PROOF_RUN_ID"
```

Missing the private key refuses both commands before mutations. This runbook
does not authorize provisioning, retrieving or using real credentials.
If the live process is killed or its cleanup is interrupted, supply the
authorized existing operator and private management credentials and reopen the same directory:

```sh
set +x
export PIPECAT_OPERATOR_TOKEN=...
export PIPECAT_PRIVATE_API_KEY=...
export PIPECAT_ORGANIZATION=...
node scripts/provider-contract/run.mjs recover --run-dir \
  "$HOME/.local/state/duplexd/provider-proof/$PROVIDER_PROOF_RUN_ID"
```

`recover` is cleanup-only. It cannot deploy, start or resume a case, open a
browser witness, or reconstruct a lost callback credential. It reads exact
owned identities from `recovery.json`, records resource snapshots, reconciles
known sessions, and retains the probe service while any target/dispatch remains
unresolved or complete scoped zero-active proof is missing. Only durable
terminal/resource and zero-active observations permit service deletion, followed
by probe-absence and unchanged-production checks. Service deletion is never an
emergency stop: active sessions can outlive it. Memory-only containment after
disk failure never deletes the service, even if reads look terminal.

The runner fails closed unless the production baseline is exact, it has no
active session, and the temporary service is absent.
A nonzero deploy CLI exit is reconciled against bounded authoritative manifest
readback for that exact build; it is never retried. Evidence retains only the
CLI exit code, an allowlisted failure category, a salted build reference, and
whether readback reconciled the outcome. Raw CLI output and provider
identifiers are never written.
It creates the temporary probe service with min/max 0/1 and no secret set,
refuses inherited secrets, applies and reads back the 600-second provider
ceiling before case 1, performs at most six serial starts, never retries an
ambiguous start, and retains the original 720-second case deadline across
recovery. Before every start, stop, and delete it syncs an intent. An accepted
callback is acknowledged only after its identity and sanitized event are
durable. Concurrent identical callbacks are idempotent; conflicting duplicates
retain all authenticated identity candidates and durably block the case without
replacing the earlier evidence. An exact start-response session ID is retained
before validating the remaining room/token fields.

Stop recovery always reads the exact session first. It makes at most three
same-ID stop attempts in total (including the repeated-stop case), with persisted counters and 5-second then
15-second minimum spacing, and reads status again before each attempt. CLI service
outcomes, session HTTP responses, timeouts and interruptions remain distinct.
Success is not rewritten as `404`, and `404` is not termination until an
independent exact-session read says the session ended. Permission or ownership
failures stop destructive mutation. Readback `401`/`403` and stop permission
errors persist a mutation barrier across recovery attempts; safe readbacks still
run. Late recovery takes a bounded final exact-session snapshot without resetting
the original deadline or issuing a late stop retry. An active/unknown target,
missing resource samples, unresolved dispatch, failed list, or incomplete list
retains the service and recovery checkpoint. An empty local target set alone
does not prove zero active provider sessions.

On success, failure, or signal, cleanup records independent results without
overwriting the first case or operation failure. It captures terminal and
resource observations before deleting the temporary service, verifies the
service absent, and requires authenticated readback of the unchanged production
build/digest, min/max 0/3, `duplexd-agent-secrets`, absent duration override,
zero active sessions, unchanged validated private-key ID inventory, and absent
`duplexd-provider-proof` secret set. For future runs, the preflight inventory
may be nonempty: its exact sorted IDs are retained only in the private checkpoint
and compared through cleanup/recovery. Missing, malformed, duplicate, added or
removed IDs fail closed. No key is created or revoked. Inventory equality does
not establish which key was supplied or its authorization. The historical
zero-private-key observations above describe the earlier attempts, not this
revised future-run invariant.
The first exercise signal starts cleanup with a fresh cancellation signal;
an interruption during cleanup aborts in-flight HTTP/CLI work and prevents
later stop/delete mutations. Recovery itself is interruptible the same way.
Unknown starts are never redispatched or matched by timestamp/list proximity.
An operator-only start response can support labeled emergency containment, but
cannot pass application recovery; only authenticated registration can supply
the application's lost-response identity.

Provider termination, unchanged resource samples, runtime estimates, and
authoritative billed usage are separate observations. The current provider
surface has no documented authoritative final-billing source in this runner,
so `confirmedBilledMinutes` stays `null` and `accountingStatus`/`usageStatus`
stay `unknown`. Resource acceptance is separate: `resourceStatus` (also the
compatibility `status` field) can pass only with all six cases, exact bounded
terminal/resource evidence, required registration/media observations, full
reservation ledger and verified cleanup. Missing accounting alone does not
block case advancement or require retaining an otherwise terminal service.
Ceiling cases poll exact termination after participant ejection; ejection alone
never releases the next start. Repeated identical metric polls do not
upgrade billing to confirmed. No billing adapter or invoice-finality claim is
added; accounting reconciliation remains separate from resource proof.

## Merge rule

**A01 and dependent A03 remain blocked pending separately authorized live
resource evidence.** Final accounting remains independently unknown. Offline crash/recovery tests validate the local
mechanism only; they cannot establish provider termination, Daily ejection,
delayed billing finality, or actual private-key permissions/behavior. Keep PR #71 draft and retain the disposable probe. The
historical `live-evidence.json` remains unchanged: one session started, zero
cases completed, and billed usage is unknown.
