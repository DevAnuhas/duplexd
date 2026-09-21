# Provider contract harness

Issue [#60](https://github.com/DevAnuhas/duplexd/issues/60) owns this bounded
harness for validating Pipecat Cloud session lifetime and cleanup. It uses only
Node built-ins and does not import the workspace or agent applications.

## Current gate

The committed fixture is synthetic. A successful offline validation proves the
schema and safety checks, **not** provider cleanup. The bounded live exercise is
authorized, but provider mutation remains paused at the executable preflight
gate. A03 remains blocked until the live exercise runs, cleanup is verified,
and a live evidence document passes the same validator. Follow the
[live operator sequence](live/OPERATIONS.md); authorization is limited to that
exact envelope.

Do not put provider credentials, tenant data, phone numbers, recordings, room
URLs, raw call IDs, raw session IDs, or Daily tokens in evidence. Convert call
and session identifiers to one-way references over stdin:

```sh
printf '%s' "$REFERENCE" | node scripts/provider-contract/run.mjs safe-ref
```

Validate the offline fixture from the repository root:

```sh
node scripts/provider-contract/run.mjs validate \
  scripts/provider-contract/fixtures/synthetic-complete.json
```

Expected result: exit zero with `"verdict": "blocked_live_gate"`. Only
`observationMode: "live"` can return `"pass"`.

## Evidence rules

- The start response and runner registration must correlate by the exact
  provider session reference. Timestamp matching is forbidden.
- Every cleanup retry must target the same known session reference.
- A stop `404` is unresolved until service identity and session status are
  reconciled. It is not proof of cleanup by itself.
- Every case carries media configuration bound to that case's session
  reference. Room and both participant credentials must expire by that case's
  absolute deadline and eject at expiry. The browser participant must be
  non-owner and both credentials must be room-scoped.
- Room ejection proves media cessation only. Process termination and usage
  cessation require separate observations.
- Each case records the injected fault, the boundary that actually stopped the
  resource, and safe timestamps/references.
- A true check is not evidence by itself. Each asserted outcome must have a
  matching same-session timestamped observation: start response, runner
  registration, stop response, exact-session status, Daily participant event,
  or provider usage. Synthetic observations cannot satisfy a live run.

## Live operator prerequisites

These are names and access scopes, not authorization to obtain or configure
them:

| Prerequisite              | Minimum scope                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| `PIPECAT_API_KEY`         | Existing public start key for the dedicated test agent only                                 |
| `PIPECAT_OPERATOR_TOKEN`  | Existing authenticated operator token for the approved org; never written to evidence       |
| `PIPECAT_ORGANIZATION`    | Exact existing organization containing `duplexd-agent`                                      |
| Temporary private key     | One runner-created `Stage A provider proof` key; revoked and verified absent during cleanup |
| Temporary activation set  | One four-value `duplexd-provider-proof` set; never modify `duplexd-agent-secrets`           |
| Test deployment           | Existing service only, `min_agents = 0`, `max_agents = 1`, no production traffic            |
| Platform ceiling          | `maxSessionDuration = 600` seconds, read back from the active deployment                    |
| Operator containment      | 720 seconds from dispatch, including startup and exact-session reconciliation               |
| Base image                | Dockerfile pinned to Pipecat Cloud base image `0.1.29`                                      |
| Daily and evidence access | Effective claims plus exact-session status/resource metrics after teardown                  |

The live envelope is authorized, but the reviewed commit is not released for
execution. Do not create the key/secret set, deploy, open the tunnel, change
duration, or start sessions until the coordinator explicitly releases the
exact committed head after safety re-review.

## Bounded live plan

Run serially with concurrency one. The operator-side fault shim may retain an
exact session reference long enough to verify the provider while deliberately
discarding it from the simulated application path; this proves the unknown
application state without timestamp-based ownership guesses.

1. Cold start with `min_agents = 0`; verify response fields, exact runner
   `session_id` registration, and readiness within 120 seconds.
2. Cancel after start and before browser join; verify exact-session stop and
   independent process/usage cessation.
3. Discard the start response after acceptance while allowing registration;
   stop the registered exact session.
4. Discard the start response and suppress registration; let the 600-second
   provider ceiling terminate the process, then prove two consecutive
   zero-active readbacks for the exact probe deployment before restoration.
5. Hang the runtime past application watchdogs; verify browser and agent media
   ejection plus provider process and usage cessation.
6. Retry cleanup against one session, including a post-stop `404`; reconcile
   agent identity and ended status instead of treating the `404` as success.

Budget at most six provider sessions, one at a time, with a hard billed-usage
allowance of 72 provider session-minutes total. That ceiling includes the
provider-documented startup and teardown time around the six 10-minute runtime
bounds. Stop when either limit is reached, or on the first unbounded or
uncorrelatable session. Do not raise the ceiling, add warm capacity, or redial
an ambiguous start.

The 600-second value is the provider runtime ceiling, not the local cleanup
deadline. A separate 720-second operator envelope bounds HTTP dispatch,
startup, termination, and reconciliation inside the authorized 12 billed
minutes per session. Exact-session status and usage must be identical across
two consecutive polls; one delayed metrics sample is not treated as failure.

## Source snapshot

Checked 2026-09-21:

- [Start API](https://docs.pipecat.ai/api-reference/pipecat-cloud/rest-reference/endpoint/start)
  documents `sessionId`, `dailyRoom`, and `dailyToken`.
- [Stop API](https://docs.pipecat.ai/api-reference/pipecat-cloud/rest-reference/endpoint/stop)
  uses a private key and an exact agent/session path; `404` also covers a wrong
  service.
- [Session listing](https://docs.pipecat.ai/api-reference/pipecat-cloud/rest-reference/endpoint/agent-get-sessions)
  exposes session/deployment fields but no call-body correlation.
- [Session duration limits](https://docs.pipecat.ai/pipecat-cloud/fundamentals/active-sessions#session-duration-limits)
  document a 60–14,400 second platform ceiling, a 7,200 second default, and the
  base-image `0.1.27` enforcement caveat. Usage includes startup and teardown.
- [Daily room expiry](https://docs.daily.co/reference/rest-api/rooms/config)
  does not eject current participants unless `eject_at_room_exp` is enabled.
- [Daily token expiry](https://docs.daily.co/reference/rest-api/meeting-tokens/config)
  says token ejection settings override room settings.
- Pinned Pipecat 1.11.0 source at commit
  `3dede06bec0b497bddfdcf047af7495ee9d0726e` defines
  `RunnerArguments.session_id` in `src/pipecat/runner/types.py`.
