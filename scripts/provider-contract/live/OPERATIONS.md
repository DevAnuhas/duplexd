# A01 live operator sequence

This runbook is executable only after the operator receives the separate live
execution go-ahead. The current offline preflight does not authorize any of
these mutations. Never enable shell tracing and never print either API key or
the callback secret.

## Fixed envelope

- Existing agent only: `duplexd-agent`; do not provision another service.
- Existing baseline: deployment `95a4b2b4`, build `3010f496`, digest
  `sha256:032aa1f121bc91a22748c725966bfd21e6659daaf8b159d367fd6e0f7a745242`.
- Six starts maximum, serial concurrency one, 12 billed minutes per session,
  72 billed minutes total.
- Probe deployment: `min=0`, `max=1`, duration ceiling 600 seconds.
- Baseline restoration: `min=0`, `max=3`, duration field absent.
- No production traffic, phone calls, recordings, transcripts, tenant data,
  Boring Host, Vapi, or Twilio.

## Offline preflight

From the repository root:

```sh
node scripts/provider-contract/live/preflight.mjs plan
node --test scripts/provider-contract/test/*.test.mjs
node --check scripts/provider-contract/live/*.mjs
cd agent
uv run ruff check duplexd_agent tests
uv run mypy duplexd_agent
uv run pytest
```

The operator must then create one temporary private Pipecat key named
`Stage A provider proof` without copying it to a file, command argument, log,
or repository. Generate a 32-byte base64url callback secret in memory, start
the loopback-only collector, and expose only its `/probe-events` endpoint:

```sh
export PROVIDER_CONTRACT_RUN_ID="stage-a-$(date -u +%Y%m%dT%H%M%SZ)"
export PROVIDER_CONTRACT_CASE_IDS="cold_start,cancel_before_join,lost_start_response_registered,no_registration_startup,hung_runtime,known_session_stop_retry"
export PROVIDER_CONTRACT_HMAC_SECRET="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"
node scripts/provider-contract/live/collector.mjs
ngrok http http://127.0.0.1:<collector-port>
```

The probe callback URL is the temporary HTTPS ngrok URL plus `/probe-events`.
The container start body may carry only that URL, the one-time HMAC secret,
run/case/boot identifiers, and a probe mode. Destroy all of them after the
gate.

## Provider state transitions

Each arrow is a gate. A failed read-back goes directly to abort cleanup.

```text
baseline read-back
  -> temporary private key present
  -> probe deployment (min0/max1)
  -> maxSessionDuration=600 read back
  -> collector+tunnel ready
  -> six serial cases
  -> no active sessions
  -> baseline build redeployed (min0/max3, no duration field)
  -> temporary private key revoked
  -> exact rollback read-back passes
  -> tunnel stopped, environment unset, volatile state destroyed
```

Deploy the temporary probe and set the ceiling only inside the approved live
window:

```sh
cd agent
uv run pipecat cloud deploy duplexd-agent --build-dir . --dockerfile Dockerfile --min-agents 0 --max-agents 1 --secrets duplexd-agent-secrets --profile agent-1x
```

Then use the authenticated private deployment update path to set
`maxSessionDuration=600`; require the active manifest to report
`maxSessionDurationSeconds=600` before the first start.

Run these cases in order, never starting the next until exact-session status
and billed usage for the prior case are reconciled:

| Case                             | Probe mode                   | Operator fault                                                                                  | Required termination                           |
| -------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `cold_start`                     | `register_join_wait`         | cold `min=0` start                                                                              | exact stop after readiness                     |
| `cancel_before_join`             | `register_pause_before_join` | cancel before browser join                                                                      | exact stop                                     |
| `lost_start_response_registered` | `register_pause_before_join` | discard response from application view; retain only volatile witness                            | stop registered exact session                  |
| `no_registration_startup`        | `no_register_join_wait`      | discard response and suppress application registration; retain only volatile operator callbacks | 600-second provider ceiling                    |
| `hung_runtime`                   | `register_join_wait`         | keep process alive after media ejection                                                         | 600-second provider ceiling                    |
| `known_session_stop_retry`       | `register_pause_before_join` | repeat stop against same exact session                                                          | 200, then 404 plus ended-status reconciliation |

The runner aborts on a 120-second startup timer, 600-second whole-case timer,
more than one active case, a seventh start, more than 12 billed minutes for one
case, more than 72 total billed minutes, or any uncorrelatable session. Abort
cleanup stops every exactly known session, restores baseline, revokes the
temporary key, and performs the same read-back gate.

## Exact rollback

Always execute this sequence, including after a failed case:

```sh
cd agent
uv run pipecat cloud deploy duplexd-agent --build-id 3010f496 --min-agents 0 --max-agents 3 --secrets duplexd-agent-secrets --profile agent-1x
```

Read back the active manifest, active sessions, and keys into volatile files,
then run:

```sh
node scripts/provider-contract/live/preflight.mjs verify-rollback <manifest.json> <sessions.json> <keys.json>
```

The gate requires agent `duplexd-agent`, build `3010f496`, the pinned digest,
`min=0`, `max=3`, no
`maxSessionDurationSeconds` field, zero active sessions, and no private key.
The provider may assign a new deployment ID when the baseline build is
redeployed; `95a4b2b4` identifies the original read-only baseline and is not a
valid equality check after restoration.
If redeployment does not remove the duration field, leave the safer 600-second
value in place, revoke the key, stop the run, and report blocked. Never write
7200 as a substitute. Finally stop ngrok and the collector, unset all temporary
environment variables, and delete volatile read-back/evidence staging files.
