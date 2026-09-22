# Gated Sandbox server protocol

Status: implemented server-side for offline testing. Production voice admission is hard-disabled. This is not provider capability proof, runtime integration, or completion of #62. [ADR 014](../decisions/014-gated-sandbox-protocol.md) explains the staged rollout.

## Ownership and source

The typed contract is [sandbox/protocol.ts](../../apps/workspace/src/sandbox/protocol.ts); [sandbox/lifecycle.ts](../../apps/workspace/src/sandbox/lifecycle.ts) owns transactions, owner checks, deadlines and reconciliation. The exported production instance has no transport. Only explicitly injected offline dependencies can dispatch, deliver a join credential or renew presence; there is no environment or HTTP opt-in. Existing workspace start/join/presence routes continue returning `503 sandbox_execution_disabled`. Prepare/expiry/cancel keep their session, Origin, CSRF and controller-proof contract.

An attempt row lock serializes dispatch, registration, claim, stop and result reconciliation. Dispatch commits `dispatching`, the token hash and absolute deadlines before one transport request; raw token exists only in the unchanged runner body `{callId, apiBase, agentToken}`. A duplicate start never remints or resends. Process loss between commit and request is unknown, not permission to retry.

## Runtime handoff to A04

Every new-protocol request sends `Authorization: Bearer <call token>` and `x-duplexd-protocol: sandbox-v1`. Session and boot IDs are opaque strings of 1–128 ASCII letters, digits, `_` or `-`.

| Request | Additional input | Success response |
| --- | --- | --- |
| `POST /v1/agent/calls/:id/register` | JSON `{sessionId, bootId}`, maximum 4 KiB | `{protocol: "sandbox-v1", registered: true}` |
| `GET /v1/agent/calls/:id/config` | `x-duplexd-session-id`, `x-duplexd-boot-id` | `{protocol, owner: {sessionId, bootId}, config, control}` |
| `GET /v1/agent/calls/:id/control` | Same owner headers | `{protocol, control}` |

Protocol and registered owner cannot be replaced. Same-owner registration is idempotent while execution is valid. Conflicting identity stops execution and preserves observed session references for exact cleanup. An authenticated late registration may reveal the lost start's exact target, but cannot claim configuration or reconstruct a missing join token. Registration after confirmed cleanup or the reporting deadline is refused.

`config` has the existing camelCase runtime configuration keys. It uses the frozen Practice snapshot, a new per-call encrypted Practice secret and internal `/v1/practice/calls/:id/tools` URL; no customer endpoint or webhook secret is read. Owner, stop intent and deadlines are checked before minting/returning plaintext. Claim is atomic and one-time: retry returns 409, never plaintext. Claim is not readiness. A04 must call the authenticated internal `markReady` hook only after backend, transport and voice-session barriers pass; this slice adds no readiness/evidence HTTP acceptance.

`control` contains `stopRequested`, `stopReason`, `startupDeadline`, `executionDeadline`, `presenceExpiresAt`, `serverTime`, `pollIntervalMs`, `controlLossTimeoutMs`, `gracefulStopMs` and `reportingGraceMs`. Dates are ISO strings. Poll interval is 3 seconds; control loss stops execution after 30 seconds; graceful stop allows 10 seconds; reporting-only grace is 60 seconds. Polling does not extend startup, execution or browser presence. A late request applies the original earliest due deadline rather than starting a fresh grace period.

Legacy Integration requests retain their exact config, ACK and completion shapes. Legacy config/events/completion reject Sandbox credentials before mutation. New-protocol evidence ACK/completion and Python changes belong to A04; they are not silently accepted by old handlers. No path in this slice writes a clean `ended` state. Unclaimed termination is `failed`; claimed termination without authenticated completion is `incomplete`.

## Browser and deadlines

Prepare/current/status retain existing fields and literal `execution: "disabled"`. They add `resourceState`, nullable `startupDeadline`, `executionDeadline` and `presenceExpiresAt`; no owner proof, provider ID, snapshot or credential is projected. Status is account-scoped. Join/presence require the initiating user and original tab proof. Stop requires the initiating session but not the lost tab proof.

Offline join output is `{sessionId, dailyRoom, dailyToken, expiresAt}`, only for the controller while unexpired and non-stopping, never from status/current. Its encrypted envelope binds the credential to attempt and call. A future transport must supply only the browser participant's room-scoped token, never an agent/admin/provider key. The current injected seam is not evidence that a real provider satisfies that requirement.

Preparation expires after 30 seconds. Startup is bounded by 120 seconds, execution by 600 seconds from dispatch, and presence by a renewable 60-second lease. Presence never extends execution or resurrects an attempt. Stop intent commits before cleanup; a late successful start cannot return join credentials after intent. Status, control and the authenticated sweep advance due state; no serverless background timer is assumed. Sweep handles at most 100 attempts, oldest-reconciled first. Production sweep performs no provider I/O.

## Exact resource reconciliation

Resource state is separate from call state: `not_dispatched`, `possible`, `known_running`, `stop_requested`, or `confirmed_stopped`. Unknown outcomes retain the user slot/account capacity until authoritative evidence exists. Elapsed time, a closed browser, call completion, DELETE acknowledgement, 404 or an empty listing cannot release the slot. No hard provider ceiling or billing amount is invented.

The injected transport has `start`, exact `read(sessionId)` and exact `stop(sessionId)`. A future live adapter must use independently verified private service/deployment binding and private API authority for `GET`/`DELETE /v1/agents/{agentName}/sessions/{sessionId}`. It must not substitute public start credentials or operator/CLI authority, learn ownership from the first observed session, or copy the spike framework into the app. Readback must match session, organization, service, deployment and configured agent before any stop or terminal conclusion.

Every observed session has a durable reconciliation lease and stop-attempt count. Cleanup reads freshly before each stop, permits at most three stops with 5- then 15-second spacing, and commits the count before sending. Lost stop responses consume their try. Forbidden or mismatched ownership blocks further mutations. Only matching terminal readback confirms termination. Slot release also waits for dispatch settlement and every observed session to be confirmed stopped. Resource proof does not establish billed duration; billing remains unknown.

## Rollout and rollback

Apply the additive migration first. Old Integration code ignores new Sandbox fields. Keep admission disabled while A04 integrates ownership/control/readiness/evidence and #60 proves real private-session behavior. Enablement needs a separately authorized adapter and capability review; changing a UI or environment variable cannot enable this implementation. Rollback disables admission first, retains handlers for existing attempts, and never drops additive records or clears unresolved slots to make the dashboard look finished.
