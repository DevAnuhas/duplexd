from __future__ import annotations

from copy import deepcopy
from typing import Any

import pytest

from duplexd_agent.config import AgentConfig, RunnerInput
from duplexd_agent.errors import AgentConfigError, RunnerInputError


@pytest.mark.parametrize("key", ["callId", "apiBase", "agentToken"])
@pytest.mark.parametrize("bad_value", [pytest.param(None, id="missing"), "", 42])
def test_runner_input_rejects_missing_empty_and_wrong_type(
    runner_body: dict[str, str], key: str, bad_value: object
) -> None:
    body: dict[str, object] = dict(runner_body)
    if bad_value is None:
        body.pop(key)
    else:
        body[key] = bad_value

    with pytest.raises(RunnerInputError, match=key):
        RunnerInput.from_body(body)


@pytest.mark.parametrize(
    "body",
    [None, [], "callId=call_test_123"],
)
def test_runner_input_requires_an_object(body: object) -> None:
    with pytest.raises(RunnerInputError, match="object"):
        RunnerInput.from_body(body)


@pytest.mark.parametrize(
    "api_base",
    ["api.example.test", "ftp://api.example.test", "https://user:pass@api.example.test"],
)
def test_runner_input_requires_safe_absolute_platform_url(
    runner_body: dict[str, str], api_base: str
) -> None:
    runner_body["apiBase"] = api_base

    with pytest.raises(RunnerInputError, match="apiBase"):
        RunnerInput.from_body(runner_body)


def test_runner_input_uses_wire_aliases(runner_body: dict[str, str]) -> None:
    parsed = RunnerInput.from_body(runner_body)

    assert parsed.call_id == runner_body["callId"]
    assert parsed.api_base == runner_body["apiBase"]
    assert parsed.agent_token == runner_body["agentToken"]


REQUIRED_CONFIG_FIELDS = (
    "assistantId",
    "voice",
    "instructions",
    "accentStyle",
    "waitingBehavior",
    "backendModel",
    "backendInstructions",
    "serverUrl",
    "serverSecret",
    "tools",
    "webhookTimeoutSecs",
    "functionCallTimeoutSecs",
    "delegationTimeoutSecs",
)


@pytest.mark.parametrize("key", REQUIRED_CONFIG_FIELDS)
def test_agent_config_rejects_each_missing_required_field(
    config_payload: dict[str, Any], key: str
) -> None:
    config_payload.pop(key)

    with pytest.raises(AgentConfigError, match=key):
        AgentConfig.from_response(config_payload)


@pytest.mark.parametrize(
    ("key", "bad_value"),
    [
        ("assistantId", 12),
        ("voice", None),
        ("instructions", []),
        ("accentStyle", None),
        ("waitingBehavior", 3),
        ("backendModel", False),
        ("backendInstructions", {}),
        ("serverUrl", 9),
        ("serverSecret", []),
        ("tools", {}),
        ("webhookTimeoutSecs", "1"),
        ("functionCallTimeoutSecs", "5"),
        ("delegationTimeoutSecs", "10"),
    ],
)
def test_agent_config_rejects_wrong_types(
    config_payload: dict[str, Any], key: str, bad_value: object
) -> None:
    config_payload[key] = bad_value

    with pytest.raises(AgentConfigError, match=key):
        AgentConfig.from_response(config_payload)


def test_agent_config_parses_the_documented_camel_case_shape(
    config_payload: dict[str, Any],
) -> None:
    config = AgentConfig.from_response(config_payload)

    assert config.assistant_id == "assistant_test_123"
    assert config.accent_style == "Use a neutral accent."
    assert config.waiting_behavior == "Acknowledge work before waiting."
    assert config.backend_model == "gpt-test-responses"
    assert config.server_url == "https://customer.example/tools"
    assert [tool.function.name for tool in config.tools] == [
        "lookup_invoice",
        "restart_server",
    ]


@pytest.mark.parametrize(
    "server_url",
    [
        "customer.example/tools",
        "file:///etc/passwd",
        "https://user:pass@customer.example/tools",
        "https://customer.example/tools#fragment",
    ],
)
def test_agent_config_rejects_unsafe_webhook_url(
    config_payload: dict[str, Any], server_url: str
) -> None:
    config_payload["serverUrl"] = server_url

    with pytest.raises(AgentConfigError, match="serverUrl"):
        AgentConfig.from_response(config_payload)


@pytest.mark.parametrize(
    ("webhook", "function", "delegation"),
    [
        (5.0, 5.0, 10.0),
        (5.0, 4.0, 10.0),
        (5.0, 10.0, 5.0),
        (5.0, 10.0, 4.0),
    ],
)
def test_agent_config_rejects_timeout_ordering_that_can_hide_structured_failures(
    config_payload: dict[str, Any], webhook: float, function: float, delegation: float
) -> None:
    config_payload.update(
        webhookTimeoutSecs=webhook,
        functionCallTimeoutSecs=function,
        delegationTimeoutSecs=delegation,
    )

    with pytest.raises(AgentConfigError):
        AgentConfig.from_response(config_payload)


def test_agent_config_accepts_strictly_ordered_timeouts(config_payload: dict[str, Any]) -> None:
    config_payload.update(
        webhookTimeoutSecs=4.999,
        functionCallTimeoutSecs=5.0,
        delegationTimeoutSecs=5.001,
    )

    config = AgentConfig.from_response(config_payload)

    assert config.webhook_timeout_secs == 4.999


@pytest.mark.parametrize(
    ("path", "value"),
    [
        (("tools", 0, "type"), "other"),
        (("tools", 0, "function", "name"), ""),
        (("tools", 0, "function", "parameters", "type"), "array"),
        (("tools", 0, "function", "parameters", "properties"), []),
        (("tools", 0, "function", "parameters", "required"), [3]),
    ],
)
def test_agent_config_rejects_malformed_openai_tools(
    config_payload: dict[str, Any], path: tuple[object, ...], value: object
) -> None:
    payload = deepcopy(config_payload)
    target: Any = payload
    for part in path[:-1]:
        target = target[part]
    target[path[-1]] = value

    with pytest.raises(AgentConfigError, match="tools"):
        AgentConfig.from_response(payload)
