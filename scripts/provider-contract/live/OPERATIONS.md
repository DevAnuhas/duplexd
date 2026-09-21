# A01 live operator sequence

This procedure is blocked until the coordinator sends a fresh live-release
message after reviewing the exact commit. The approved resources are one
temporary private key, one temporary secret set named
`duplexd-provider-proof`, one temporary ngrok tunnel, one probe deployment on
the existing `duplexd-agent`, and at most six serial sessions. Nothing here
authorizes another service, phone traffic, production traffic, warm capacity,
Boring Host, Vapi, or Twilio.

The executable owns the entire mutation sequence and cleanup. Do not reproduce
its steps manually. Never enable shell tracing or print credentials.

## Fixed identities and limits

| Item                  | Exact value                                                               |
| --------------------- | ------------------------------------------------------------------------- |
| Agent                 | `duplexd-agent`                                                           |
| Original deployment   | `95a4b2b4-6fed-47c8-8539-e820347f35fe`                                    |
| Baseline build        | `3010f496-fd84-4f39-a75c-c4a58a1bd922`                                    |
| Baseline digest       | `sha256:032aa1f121bc91a22748c725966bfd21e6659daaf8b159d367fd6e0f7a745242` |
| Baseline secret set   | `duplexd-agent-secrets`                                                   |
| Temporary secret set  | `duplexd-provider-proof`                                                  |
| Temporary private key | `Stage A provider proof`                                                  |
| Sessions              | Six maximum, concurrency one                                              |
| Usage                 | 12 billed minutes per session, 72 total                                   |
| Timers                | 120-second startup, 600-second provider ceiling, 720-second containment   |
| Probe scaling         | `min=0`, `max=1`                                                          |
| Restored scaling      | `min=0`, `max=3`                                                          |

The temporary secret set contains exactly four keys:

- `PROVIDER_CONTRACT_PROBE_ENABLED`
- `PROVIDER_CONTRACT_PROBE_RUN_ID`
- `PROVIDER_CONTRACT_PROBE_CALLBACK_URL`
- `PROVIDER_CONTRACT_PROBE_ACTIVATION_SECRET`

The start body cannot activate the probe by itself. The agent requires the
deployment-owned enabled value, exact approved run ID, exact callback URL, and
a valid per-case HMAC activation proof. Ordinary calls continue down the normal
path. Any body-only probe request fails closed without making a callback.

## Offline gate

From the repository root:

```sh
node scripts/provider-contract/live/preflight.mjs plan
node --test scripts/provider-contract/test/*.test.mjs
for file in scripts/provider-contract/live/*.mjs; do node --check "$file"; done
cd agent
uv run ruff check duplexd_agent tests
uv run mypy duplexd_agent
uv run pytest
```

The branch must already contain current `origin/main`, the worktree must be
clean, and PR #67 must remain draft.

## Exact live command

After the coordinator's separate release, use one terminal. Supply the
existing public start key and existing authenticated Pipecat operator token
only through the environment. The approved run ID comes from the coordinator.
The evidence path contains sanitized JSON only. `ngrok` must already be
installed and authenticated on this Mac; the executable owns its temporary
process and never receives or prints the ngrok account token.

```sh
export PIPECAT_API_KEY='<existing public start key>'
export PIPECAT_OPERATOR_TOKEN='<existing OAuth/PAT operator token>'
export PIPECAT_ORGANIZATION='<existing organization name>'
export PROVIDER_CONTRACT_RUN_ID='<approved run ID>'
export PROVIDER_CONTRACT_EVIDENCE_PATH="$(pwd)/scripts/provider-contract/fixtures/live-evidence.json"
export PROVIDER_CONTRACT_SECRET_SET_APPROVED='duplexd-provider-proof'
export PROVIDER_CONTRACT_LIVE_RELEASE='stage-a-provider-proof-live-release'
node scripts/provider-contract/live/execute.mjs execute
```

Do not set the last two release variables before the coordinator's explicit
message. Missing or wrong values stop before any provider request.

The executable performs this sequence:

```text
strict baseline + zero-session/key/secret-set preflight
  -> loopback collector
  -> owned ngrok HTTPS tunnel
  -> create four-value temporary secret set
  -> create one named private key
  -> build/deploy probe with min0/max1 and temporary secret set
  -> set and read back maxSessionDurationSeconds=600
  -> run six cases serially with a distinct 720s operator containment guard
  -> poll exact-session status/usage until two consecutive stable observations
  -> restore full baseline build/min0/max3/original secret-set reference
  -> revoke every matching temporary private key
  -> delete temporary secret set only after verified baseline restoration
  -> verify full build/digest/scaling/secret-set, absent duration, zero active
     sessions, zero private keys, and absent temporary secret set
  -> close tunnel/collector and destroy raw join/token state
  -> write sanitized evidence only when cleanup verifies
```

For the cases that join Daily, the executable prints a path to a mode-600
temporary HTML file. Open that local file in a visible browser, then type the
exact witness phrase printed by the executable. No raw room URL, token, or
session ID is printed. The file is deleted after the case. No microphone
content or recording is required.

The six cases are fixed in code: cold start, cancel before join, lost response
with registration, no application registration, hung runtime, and same-session
stop retry with a reconciled 404. The executable never retries `start`.

An ambiguous `start` response does not trigger immediate restoration. The
runner keeps the probe deployment and secret set intact while it waits for the
exact boot callback through the 120-second startup window. If registration
arrives it stops and reconciles that exact session. Otherwise it waits through
the provider's 600-second ceiling and requires two consecutive zero-active
readbacks scoped to the exact probe deployment during the remaining bounded
allowance. It never retries `start` or guesses ownership from timestamps. If
zero active probe sessions cannot be proved, baseline restoration and secret
set deletion stay blocked for containment.

## Abort and containment

SIGINT, SIGTERM, a timeout, a seventh/concurrent start, an uncorrelatable
callback, a response-shape mismatch, unstable usage, or any failed gate enters
the same cleanup path. The deploy subprocess has a ten-minute hard timeout;
signals terminate its process tree and wait for exit before cleanup continues.
Cleanup waits for any other in-flight mutation, stops every
exactly known session, restores the baseline, revokes the temporary key, then
deletes the temporary secret set. All readback errors are redacted.

If baseline restoration is not verified, the executable deliberately leaves
the temporary secret set in place rather than deleting configuration still
referenced by an uncertain deployment. It still attempts key revocation,
closes the tunnel, and writes a mode-600 local containment record containing
the exact volatile IDs needed for manual recovery. It emits no live-pass
evidence. If the provider will not remove the duration override, leave the
safer 600-second value, revoke the key, and report blocked; never substitute 7200.

The original deployment ID identifies the inspected baseline. A successful
redeploy may receive a new deployment ID, so rollback compares the full build
UUID, immutable digest, scaling, original secret-set reference, and omitted
duration field instead of requiring the deployment ID to stay unchanged.

After a successful run, unset all credentials and release variables. Before PR
#67 can be marked ready, remove the temporary probe branch/module (or replace
it with a permanent compile-time-disabled state) and rerun the ordinary agent
suite. Live evidence alone does not make the temporary probe mergeable.
