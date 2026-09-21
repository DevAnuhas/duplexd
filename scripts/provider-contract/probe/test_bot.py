from __future__ import annotations

import base64
import json
from typing import Any

import pytest
from pipecat.runner.types import DailyRunnerArguments

from bot import CASES, daily_claims, parse_request, run_probe


def request(case: str = "cold_start") -> dict[str, Any]:
    return {
        "providerProof": {
            "case": case,
            "runId": "stage-a-proof-r5",
            "bootId": "boot-0001",
            "callbackUrl": f"https://proof.example/probe/stage-a-proof-r5/{case}/boot-0001",
            "callbackSecret": "A" * 43,
        }
    }


def args(case: str) -> DailyRunnerArguments:
    claims = (
        base64.urlsafe_b64encode(
            json.dumps(
                {
                    "properties": {
                        "exp": 123,
                        "eject_at_token_exp": True,
                        "is_owner": False,
                        "room_name": "bounded-room",
                    }
                }
            ).encode()
        )
        .decode()
        .rstrip("=")
    )
    return DailyRunnerArguments(
        room_url="https://example.daily.co/bounded-room",
        token=f"x.{claims}.x",
        body=request(case),
        session_id="session-exact",
    )


@pytest.mark.parametrize("case", CASES)
def test_accepts_only_six_cases(case: str) -> None:
    assert parse_request(request(case))["case"] == case


@pytest.mark.parametrize(
    "change",
    [
        lambda value: value.update(extra="no"),
        lambda value: value["providerProof"].update(case="other"),
        lambda value: value["providerProof"].update(callbackSecret="short"),
        lambda value: value["providerProof"].update(
            callbackUrl="http://localhost/probe"
        ),
        lambda value: value["providerProof"].update(
            callbackUrl="https://proof.example/probe/wrong"
        ),
    ],
)
def test_request_validation_fails_closed(change: Any) -> None:
    value = request()
    change(value)
    with pytest.raises(ValueError, match="provider proof"):
        parse_request(value)


def test_daily_claims_are_minimal_and_bounded() -> None:
    value = args("cold_start")
    assert daily_claims(value.token) == {
        "expiresAtEpochSeconds": 123,
        "ejectAtTokenExpiry": True,
        "isOwner": False,
        "roomScoped": True,
    }


@pytest.mark.asyncio
@pytest.mark.parametrize("case", CASES)
async def test_each_case_has_only_its_declared_registration_and_join(case: str) -> None:
    events: list[str] = []
    joined = False

    async def notify(_config: Any, session_id: str, _token: Any, event: str) -> None:
        assert session_id == "session-exact"
        events.append(event)

    async def join(_args: Any, callback: Any) -> None:
        nonlocal joined
        joined = True
        await callback("agent_joined")
        await callback("agent_ejected")

    async def hold() -> None:
        return None

    await run_probe(args(case), notify_impl=notify, join_impl=join, hold_impl=hold)
    register, should_join = CASES[case]
    assert ("registered" in events) is register
    assert joined is should_join
    assert ("agent_ejected" in events) is should_join


@pytest.mark.asyncio
async def test_missing_session_id_never_calls_back() -> None:
    called = False

    async def notify(*_args: Any) -> None:
        nonlocal called
        called = True

    value = args("cold_start")
    value.session_id = None
    with pytest.raises(ValueError, match="session ID"):
        await run_probe(value, notify_impl=notify)
    assert not called
