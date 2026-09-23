from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

import httpx
import pytest

from duplexd_agent.config import RunnerInput
from duplexd_agent.errors import AgentConfigError, PlatformRequestError
from duplexd_agent.platform import (
    REPORTING_TIMEOUT_SECS,
    STARTUP_REQUEST_TIMEOUT_SECS,
    PlatformClient,
    encode_json,
)


def _runner(runner_body: dict[str, str]) -> RunnerInput:
    return RunnerInput.from_body(runner_body)


@pytest.mark.parametrize(
    "operation",
    [
        pytest.param(lambda client: client.fetch_config(), id="config"),
        pytest.param(lambda client: client.post_events(b"{\"events\":[]}"), id="events"),
        pytest.param(
            lambda client: client.post_complete(b"{\"reason\":\"client_disconnected\"}"),
            id="complete",
        ),
    ],
)
async def test_platform_requests_use_bearer_without_putting_token_in_url(
    runner_body: dict[str, str],
    config_payload: dict[str, Any],
    operation: Callable[[PlatformClient], Any],
) -> None:
    requests: list[httpx.Request] = []

    async def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json=config_payload)

    async with PlatformClient(
        _runner(runner_body), transport=httpx.MockTransport(respond)
    ) as client:
        await operation(client)

    assert len(requests) == 1
    assert requests[0].headers["authorization"] == f"Bearer {runner_body['agentToken']}"
    assert runner_body["agentToken"] not in str(requests[0].url)
    assert requests[0].url.query == b""


async def test_config_is_fetched_exactly_once_with_fixed_timeout(
    runner_body: dict[str, str], config_payload: dict[str, Any]
) -> None:
    requests: list[httpx.Request] = []

    async def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json=config_payload)

    async with PlatformClient(
        _runner(runner_body), transport=httpx.MockTransport(respond)
    ) as client:
        config = await client.fetch_config()

    assert config.assistant_id == config_payload["assistantId"]
    assert len(requests) == 1
    assert requests[0].method == "GET"
    assert requests[0].url.path == "/v1/agent/calls/call_test_123/config"
    assert requests[0].extensions["timeout"] == {
        "connect": STARTUP_REQUEST_TIMEOUT_SECS,
        "read": STARTUP_REQUEST_TIMEOUT_SECS,
        "write": STARTUP_REQUEST_TIMEOUT_SECS,
        "pool": STARTUP_REQUEST_TIMEOUT_SECS,
    }


@pytest.mark.parametrize("status", [400, 401, 404, 500, 503])
async def test_config_non_success_is_fatal_without_exposing_body_or_token(
    runner_body: dict[str, str], status: int
) -> None:
    secret_body = "webhook-secret-canary-never-log"

    async def respond(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, text=secret_body)

    async with PlatformClient(
        _runner(runner_body), transport=httpx.MockTransport(respond)
    ) as client:
        with pytest.raises(PlatformRequestError) as raised:
            await client.fetch_config()

    message = str(raised.value)
    assert f"HTTP {status}" in message
    assert secret_body not in message
    assert runner_body["agentToken"] not in message


async def test_config_timeout_is_fatal_and_sanitized(runner_body: dict[str, str]) -> None:
    async def timeout(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout(
            f"timed out with {runner_body['agentToken']}",
            request=request,
        )

    async with PlatformClient(
        _runner(runner_body), transport=httpx.MockTransport(timeout)
    ) as client:
        with pytest.raises(PlatformRequestError) as raised:
            await client.fetch_config()

    assert str(raised.value) == "assistant config request failed"
    assert runner_body["agentToken"] not in str(raised.value)


async def test_malformed_config_json_is_fatal(runner_body: dict[str, str]) -> None:
    async def respond(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"not-json")

    async with PlatformClient(
        _runner(runner_body), transport=httpx.MockTransport(respond)
    ) as client:
        with pytest.raises(PlatformRequestError, match="not JSON"):
            await client.fetch_config()


async def test_invalid_config_shape_is_fatal(
    runner_body: dict[str, str], config_payload: dict[str, Any]
) -> None:
    config_payload.pop("serverSecret")

    async def respond(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=config_payload)

    async with PlatformClient(
        _runner(runner_body), transport=httpx.MockTransport(respond)
    ) as client:
        with pytest.raises(AgentConfigError, match="serverSecret"):
            await client.fetch_config()


@pytest.mark.parametrize("suffix", ["events", "complete"])
async def test_reporting_posts_exact_bytes_with_fixed_timeout(
    runner_body: dict[str, str], suffix: str
) -> None:
    requests: list[httpx.Request] = []
    body = b'{"seq":7,"text":"exact"}'

    async def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200)

    async with PlatformClient(
        _runner(runner_body), transport=httpx.MockTransport(respond)
    ) as client:
        success = (
            await client.post_events(body)
            if suffix == "events"
            else await client.post_complete(body)
        )

    assert success is True
    assert len(requests) == 1
    assert requests[0].content == body
    assert requests[0].url.path.endswith(f"/{suffix}")
    assert requests[0].extensions["timeout"] == {
        "connect": REPORTING_TIMEOUT_SECS,
        "read": REPORTING_TIMEOUT_SECS,
        "write": REPORTING_TIMEOUT_SECS,
        "pool": REPORTING_TIMEOUT_SECS,
    }


@pytest.mark.parametrize("mode", ["http_500", "connection_refused"])
async def test_reporting_failure_returns_false_and_does_not_raise(
    runner_body: dict[str, str], mode: str
) -> None:
    async def respond(request: httpx.Request) -> httpx.Response:
        if mode == "connection_refused":
            raise httpx.ConnectError("refused", request=request)
        return httpx.Response(500)

    async with PlatformClient(
        _runner(runner_body), transport=httpx.MockTransport(respond)
    ) as client:
        assert await client.post_events(b"{}") is False
        assert await client.post_complete(b"{}") is False


def test_encode_json_is_compact_deterministic_utf8_bytes() -> None:
    value = {"z": "café", "a": [1, True]}

    first = encode_json(value)
    second = encode_json(value)

    assert first == second == b'{"z":"caf\xc3\xa9","a":[1,true]}'
    assert json.loads(first) == value
