# Provider contract harness

Issue [#60](https://github.com/DevAnuhas/duplexd/issues/60) owns this bounded
harness for validating Pipecat Cloud session lifetime and cleanup. It uses only
Node built-ins and does not import the workspace or agent applications.

## Current gate

The committed fixture is synthetic. A successful offline validation proves the
schema and safety checks, **not** provider cleanup. A03 remains blocked until an
operator separately authorizes the live exercise and a live evidence document
passes the same validator.

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

| Prerequisite | Minimum scope |
| --- | --- |
| `PIPECAT_API_KEY` | Public start key for the dedicated test agent only |
| `PIPECAT_PRIVATE_API_KEY` | Private management access to stop and list sessions for that same agent |
| Test deployment | `min_agents = 0`, `max_agents = 1`, no production traffic |
| Platform ceiling | `maxSessionDuration = 600` seconds, read back from the active deployment |
| Base image | Pipecat Cloud base image `0.1.27` or later, verified rather than inferred from `latest` |
| Daily settings | Ability to inspect effective room and both participant token claims |
| Evidence access | Exact-session status plus provider usage/billing duration after teardown |

Changing `maxSessionDuration` triggers a deployment. Do not make that change,
deploy the test agent, provision keys, or start sessions without separate
authorization.

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
   provider ceiling terminate the process.
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
