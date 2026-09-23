"""Offline sandbox wire, delivery bounds, and monotonic lease regression tests."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest

from duplexd_agent.bot import STARTUP_ENVELOPE_SECS
from duplexd_agent.config import RunnerInput, SandboxAck, SandboxControl, SandboxOwner
from duplexd_agent.errors import PlatformRequestError, RunnerInputError
from duplexd_agent.platform import (
    CONTROL_POLL_TIMEOUT_SECS,
    STARTUP_REQUEST_TIMEOUT_SECS,
    PlatformClient,
    encode_json,
)
from duplexd_agent.reporting import EventReporter
from duplexd_agent.runtime import SandboxWatchdog


def control(**updates: Any) -> SandboxControl:
    now = datetime(2026, 9, 22, tzinfo=UTC)
    return SandboxControl.model_validate(
        {
            "stopRequested": False,
            "stopReason": None,
            "serverTime": now.isoformat(),
            "startupDeadline": (now + timedelta(seconds=120)).isoformat(),
            "executionDeadline": (now + timedelta(seconds=600)).isoformat(),
            "presenceExpiresAt": (now + timedelta(seconds=60)).isoformat(),
            "pollIntervalMs": 3000,
            "controlLossTimeoutMs": 30000,
            "gracefulStopMs": 10000,
            "reportingGraceMs": 60000,
            **updates,
        }
    )


def ack(seq: int, *, complete: bool = False) -> SandboxAck:
    return SandboxAck(
        protocol="sandbox-v1",
        contiguousSeq=seq,
        missingRanges=[],
        evidenceState="complete" if complete else "unknown",
        completionDigest="a" * 64 if complete else None,
        control=control(),
    )


class EvidenceStub:
    def __init__(self) -> None:
        self.requests: list[tuple[str, bytes]] = []
        self.responses: list[SandboxAck | None] = []
        self.accept = True
        self.highest = 0

    async def post_events(self, body: bytes) -> bool:
        raise AssertionError("sandbox must never use legacy event reporting")

    async def post_complete(self, body: bytes) -> bool:
        raise AssertionError("sandbox must never use legacy completion")

    async def post_evidence(self, suffix: str, body: bytes) -> SandboxAck | None:
        self.requests.append((suffix, body))
        if self.responses:
            return self.responses.pop(0)
        if not self.accept:
            return None
        if suffix == "events":
            self.highest = json.loads(body)["events"][-1]["seq"]
        return ack(self.highest, complete=suffix == "complete")


@pytest.mark.parametrize(
    "status,payload,expected",
    [
        (404, {}, "integration-v1"),
        (200, {"protocol": "integration-v1"}, "integration-v1"),
        (200, {"protocol": "sandbox-v1"}, "sandbox-v1"),
        (403, {}, None),
        (500, {}, None),
        (200, {"protocol": "sandbox-v2"}, None),
        (200, {"protocol": "sandbox-v1", "config": {}}, None),
    ],
)
async def test_negotiation_falls_back_only_for_absent_route(
    runner_body: dict[str, str],
    status: int,
    payload: dict[str, Any],
    expected: str | None,
) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(status, json=payload)

    async with PlatformClient(
        RunnerInput.from_body(runner_body), transport=httpx.MockTransport(handler)
    ) as platform:
        if expected is None:
            with pytest.raises(PlatformRequestError):
                await platform.negotiate()
        else:
            assert await platform.negotiate() == expected
    assert len(requests) == 1
    assert requests[0].url.path.endswith("/protocol")
    assert requests[0].headers["authorization"] == f"Bearer {runner_body['agentToken']}"


@pytest.mark.parametrize("extra", ["sessionId", "bootId", "protocol", "accountId"])
def test_runner_remains_exact_three_keys(runner_body: dict[str, str], extra: str) -> None:
    with pytest.raises(RunnerInputError):
        RunnerInput.from_body({**runner_body, extra: "forbidden"})


async def test_registered_owner_headers_claim_once_and_mismatch_is_rejected(
    runner_body: dict[str, str],
    config_payload: dict[str, Any],
) -> None:
    owner = SandboxOwner(sessionId="synthetic-session", bootId="synthetic-boot")
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        assert request.headers["x-duplexd-protocol"] == "sandbox-v1"
        assert request.headers["x-duplexd-session-id"] == owner.sessionId
        assert request.headers["x-duplexd-boot-id"] == owner.bootId
        if request.url.path.endswith("/register"):
            assert json.loads(request.content) == owner.model_dump()
            return httpx.Response(200, json={"protocol": "sandbox-v1", "registered": True})
        return httpx.Response(
            200,
            json={
                "protocol": "sandbox-v1",
                "owner": {**owner.model_dump(), "bootId": "wrong-boot"},
                "config": config_payload,
                "control": control().model_dump(),
            },
        )

    async with PlatformClient(
        RunnerInput.from_body(runner_body), transport=httpx.MockTransport(handler)
    ) as platform:
        await platform.register(owner)
        with pytest.raises(PlatformRequestError, match="owner mismatch"):
            await platform.claim_sandbox()
    assert [request.url.path.rsplit("/", 1)[1] for request in requests] == ["register", "config"]


async def test_unacked_bytes_replay_unchanged_and_only_contiguous_ack_trims() -> None:
    stub = EvidenceStub()
    stub.accept = False
    reporter = EventReporter(stub, evidence_transport=stub)
    payload = {"text": "immutable original"}
    await reporter.record("transcript_user", payload)
    payload["text"] = "mutated by caller"
    await reporter.record("agent_ready", {})
    assert not await reporter.flush()
    assert not await reporter.flush()
    bodies = [body for _, body in stub.requests]
    assert len(bodies) == 4 and len(set(bodies)) == 1
    assert json.loads(bodies[0])["events"][0]["payload"] == {"text": "immutable original"}
    stub.responses = [ack(1)]
    assert await reporter.flush()
    stub.responses = [ack(2)]
    assert await reporter.flush()
    assert [e["seq"] for e in json.loads(stub.requests[-1][1])["events"]] == [2]
    before = len(stub.requests)
    assert await reporter.flush()
    assert len(stub.requests) == before


async def test_invalid_ack_cannot_drop_unsent_events_or_regress_watermark() -> None:
    stub = EvidenceStub()
    reporter = EventReporter(stub, evidence_transport=stub)
    await reporter.record("agent_ready", {})
    stub.responses = [ack(2), ack(2)]
    assert not await reporter.flush()
    assert await reporter.flush()
    await reporter.record("interruption", {})
    stub.responses = [ack(0), ack(0)]
    assert not await reporter.flush()
    assert json.loads(stub.requests[-1][1])["events"][0]["seq"] == 2


@pytest.mark.parametrize("text_size,expected_count", [(0, 1000), (7800, None)])
async def test_pending_queue_stops_at_event_or_utf8_byte_bound(
    text_size: int,
    expected_count: int | None,
) -> None:
    stub = EvidenceStub()
    stops: list[str] = []
    reporter = EventReporter(stub, evidence_transport=stub, request_stop=stops.append)
    for _ in range(1001):
        await reporter.record("transcript_user", {"text": "x" * text_size})
    assert stops and set(stops) == {"evidence_limit"}
    for _ in range(32):
        before = len(stub.requests)
        assert await reporter.flush()
        if len(stub.requests) == before:
            break
    else:
        pytest.fail("acknowledged queue failed to drain in 32 bounded batches")
    events = [
        event
        for suffix, body in stub.requests
        if suffix == "events"
        for event in json.loads(body)["events"]
    ]
    assert len(events) == expected_count if expected_count is not None else len(events) < 1000
    assert sum(len(encode_json(event)) for event in events) <= 2 * 1024 * 1024
    if text_size:
        assert (
            sum(len(encode_json(event)) for event in events) + len(encode_json(events[-1]))
            > 2 * 1024 * 1024
        )
    assert all(
        len(json.loads(body)["events"]) <= 64 and len(body) <= 256 * 1024
        for suffix, body in stub.requests
        if suffix == "events"
    )
    assert await reporter.complete("evidence_limit", 1)
    completion = json.loads(stub.requests[-1][1])
    assert completion["producerLoss"] is True
    assert completion["finalSeq"] == len(events)


@pytest.mark.parametrize("size", [8193, 20000])
async def test_oversize_event_is_loss_and_truncation_without_consuming_sequence(size: int) -> None:
    stub = EvidenceStub()
    stops: list[str] = []
    reporter = EventReporter(stub, evidence_transport=stub, request_stop=stops.append)
    await reporter.record("transcript_user", {"text": "é" * size})
    await reporter.record("agent_ready", {})
    assert await reporter.complete("evidence_limit", 1)
    assert stops == ["evidence_limit"]
    assert json.loads(stub.requests[-1][1]) == {
        "endedReason": "evidence_limit",
        "durationSecs": 1,
        "finalSeq": 1,
        "producerLoss": True,
        "truncated": True,
    }


@pytest.mark.parametrize("payload_size,expected_limit", [(0, "count"), (7800, "bytes")])
async def test_call_budget_survives_acknowledged_queue_drain(
    payload_size: int, expected_limit: str
) -> None:
    stub = EvidenceStub()
    stops: list[str] = []
    reporter = EventReporter(stub, evidence_transport=stub, request_stop=stops.append)
    count = 0
    total = 0
    while not stops:
        await reporter.record("transcript_user", {"text": "x" * payload_size})
        if stops:
            break
        assert await reporter.flush()
        event = json.loads(stub.requests[-1][1])["events"][0]
        count += 1
        total += len(encode_json(event))
    assert count == 10000 if expected_limit == "count" else count < 10000
    assert total <= 8 * 1024 * 1024
    if expected_limit == "bytes":
        assert total + len(encode_json(event)) > 8 * 1024 * 1024
    assert await reporter.complete("evidence_limit", 10)
    assert json.loads(stub.requests[-1][1])["producerLoss"] is True


async def test_completion_is_sealed_and_retries_cannot_change_reason_or_watermark() -> None:
    stub = EvidenceStub()
    reporter = EventReporter(stub, evidence_transport=stub)
    await reporter.record("agent_ready", {})
    assert await reporter.complete("client_disconnected", 1.23456)
    first = stub.requests[-1][1]
    await reporter.record("interruption", {})
    assert await reporter.complete("pipeline_error", 99)
    assert stub.requests[-1] == ("complete", first)
    assert json.loads(first) == {
        "endedReason": "client_disconnected",
        "durationSecs": 1.235,
        "finalSeq": 1,
        "producerLoss": False,
        "truncated": False,
    }


@pytest.mark.parametrize(
    "reason,seconds",
    [
        ("startup_deadline", 120),
        ("execution_deadline", 600),
        ("presence_expired", 60),
        ("control_lost", 30),
    ],
)
def test_watchdog_enforces_each_monotonic_deadline_without_late_revival(
    reason: str,
    seconds: int,
) -> None:
    from types import SimpleNamespace
    from typing import cast

    clock = [100.0]
    field = {
        "startup_deadline": "startupDeadline",
        "execution_deadline": "executionDeadline",
        "presence_expired": "presenceExpiresAt",
    }
    base = control()
    far = "2026-09-23T00:00:00Z"
    updates = {value: far for value in field.values()}
    if reason in field:
        updates[field[reason]] = getattr(base, field[reason])
    watchdog = SandboxWatchdog(
        cast(PlatformClient, SimpleNamespace(control_received_at=100.0)),
        control(**updates),
        clock=lambda: clock[0],
    )
    # Healthy control polls must not move fixed deadlines; presence can renew separately.
    for elapsed in [] if reason == "control_lost" else range(20, seconds, 20):
        clock[0] = 100 + elapsed
        response = control(
            **updates,
            serverTime=(datetime(2026, 9, 22, tzinfo=UTC) + timedelta(seconds=elapsed)).isoformat(),
        )
        watchdog.update(response, clock[0])
    clock[0] = 100 + seconds
    watchdog.check()
    assert watchdog.reason == reason
    watchdog.update(control(**{value: far for value in field.values()}), clock[0])
    assert watchdog.reason == reason and watchdog.stopped.is_set()


def test_presence_wall_clock_regression_cannot_extend_unchanged_lease() -> None:
    from types import SimpleNamespace
    from typing import cast

    clock = [0.0]
    watchdog = SandboxWatchdog(
        cast(PlatformClient, SimpleNamespace(control_received_at=0.0)),
        control(),
        clock=lambda: clock[0],
    )
    for elapsed in [20.0, 40.0]:
        clock[0] = elapsed
        # Same absolute presence, regressed server clock, fresh valid control response.
        watchdog.update(control(serverTime="2026-09-21T23:59:50Z"), clock[0])
    clock[0] = 60.0
    watchdog.check()
    assert watchdog.reason == "presence_expired"


def test_greater_presence_expiry_renews_only_while_old_lease_is_valid() -> None:
    from types import SimpleNamespace
    from typing import cast

    clock = [0.0]
    watchdog = SandboxWatchdog(
        cast(PlatformClient, SimpleNamespace(control_received_at=0.0)),
        control(),
        clock=lambda: clock[0],
    )
    clock[0] = 20.0
    watchdog.update(
        control(serverTime="2026-09-22T00:00:20Z", presenceExpiresAt="2026-09-22T00:01:20Z"),
        clock[0],
    )
    for elapsed in [40.0, 60.0]:
        clock[0] = elapsed
        watchdog.update(
            control(
                serverTime=(
                    datetime(2026, 9, 22, tzinfo=UTC) + timedelta(seconds=elapsed)
                ).isoformat(),
                presenceExpiresAt="2026-09-22T00:01:20Z",
            ),
            clock[0],
        )
    assert not watchdog.stopped.is_set()
    clock[0] = 80.0
    watchdog.update(
        control(serverTime="2026-09-22T00:01:20Z", presenceExpiresAt="2026-09-22T00:02:20Z"),
        clock[0],
    )
    assert watchdog.reason == "presence_expired"


async def test_reporting_drain_has_15_second_bound_even_when_completion_never_answers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import asyncio

    requests: list[str] = []
    deadlines: list[float] = []
    timeout = asyncio.timeout

    def short_timeout(seconds: float) -> asyncio.Timeout:
        deadlines.append(seconds)
        return timeout(0.01)

    class HungEvidence(EvidenceStub):
        async def post_evidence(self, suffix: str, body: bytes) -> SandboxAck | None:
            requests.append(suffix)
            await asyncio.Event().wait()
            return None

    monkeypatch.setattr(asyncio, "timeout", short_timeout)
    stub = HungEvidence()
    reporter = EventReporter(stub, evidence_transport=stub)
    assert not await reporter.complete("user_stopped", 1)
    assert deadlines == [15.0]
    assert requests == ["complete"]


async def test_periodic_reporter_can_stop_itself_without_self_await() -> None:
    import asyncio

    stopped = asyncio.Event()

    class SelfStoppingReporter(EventReporter):
        async def flush(self, *, heartbeat: bool = False) -> bool:
            await self.stop()
            stopped.set()
            return True

    stub = EvidenceStub()
    reporter = SelfStoppingReporter(stub, evidence_transport=stub, flush_interval_secs=0.001)
    await reporter.start()
    await asyncio.wait_for(stopped.wait(), 0.2)
    await reporter.stop()


async def test_blocked_event_delivery_does_not_block_control_stop() -> None:
    import asyncio
    import time
    from typing import cast

    delivery_started = asyncio.Event()

    class HungEvidence(EvidenceStub):
        async def post_evidence(self, suffix: str, body: bytes) -> SandboxAck | None:
            delivery_started.set()
            await asyncio.Event().wait()
            return None

    class Platform:
        control_received_at = time.monotonic()

        async def poll_control(self) -> SandboxControl:
            await delivery_started.wait()
            return control(stopRequested=True, stopReason="user_stopped")

    stub = HungEvidence()
    watchdog = SandboxWatchdog(cast(PlatformClient, Platform()), control())
    reporter = EventReporter(stub, evidence_transport=stub)
    await reporter.record("agent_ready", {})
    flush = asyncio.create_task(reporter.flush())
    await watchdog.start()
    try:
        await asyncio.wait_for(watchdog.stopped.wait(), 0.2)
        assert watchdog.reason == "user_stopped"
        assert not flush.done()
    finally:
        flush.cancel()
        await asyncio.gather(flush, return_exceptions=True)
        await watchdog.close()


async def test_startup_requests_outlast_a_slow_platform_while_control_stays_short(
    runner_body: dict[str, str], config_payload: dict[str, Any]
) -> None:
    """The first real call died on a claim that answered at 4.8 s.

    Negotiation, registration and the one-shot claim each wait out a platform
    that is paying its own cold start; the control poll, which repeats every
    three seconds, deliberately does not.
    """
    owner = SandboxOwner(sessionId="synthetic-session", bootId="synthetic-boot")
    timeouts: dict[str, float] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        suffix = request.url.path.rsplit("/", 1)[1]
        timeouts[suffix] = request.extensions["timeout"]["read"]
        if suffix == "protocol":
            return httpx.Response(200, json={"protocol": "sandbox-v1"})
        if suffix == "register":
            return httpx.Response(200, json={"protocol": "sandbox-v1", "registered": True})
        if suffix == "control":
            return httpx.Response(
                200, json={"protocol": "sandbox-v1", "control": control().model_dump()}
            )
        return httpx.Response(
            200,
            json={
                "protocol": "sandbox-v1",
                "owner": owner.model_dump(),
                "config": config_payload,
                "control": control().model_dump(),
            },
        )

    async with PlatformClient(
        RunnerInput.from_body(runner_body), transport=httpx.MockTransport(handler)
    ) as platform:
        assert await platform.negotiate() == "sandbox-v1"
        await platform.register(owner)
        await platform.claim_sandbox()
        await platform.poll_control()

    assert timeouts["protocol"] == STARTUP_REQUEST_TIMEOUT_SECS
    assert timeouts["register"] == STARTUP_REQUEST_TIMEOUT_SECS
    assert timeouts["config"] == STARTUP_REQUEST_TIMEOUT_SECS
    assert timeouts["control"] == CONTROL_POLL_TIMEOUT_SECS
    # The envelope must be able to hold three of them, or widening the request
    # budget only moves the failure into the outer bound.
    assert STARTUP_ENVELOPE_SECS > 3 * STARTUP_REQUEST_TIMEOUT_SECS
