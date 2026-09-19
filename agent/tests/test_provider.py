from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any, cast

import pytest
from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.processors.aggregators.llm_context import NOT_GIVEN
from pipecat.services.openai.live import events as live_events
from pipecat.services.openai.live.llm import OpenAILiveLLMService
from pipecat.services.openai.responses.llm import OpenAIResponsesHttpLLMService

from duplexd_agent.config import AgentConfig
from duplexd_agent.errors import BackendProbeError
from duplexd_agent.instructions import compose_instructions
from duplexd_agent.provider import (
    PROBE_TIMEOUT_SECS,
    PROBE_TOOL_NAME,
    ResponsesToolProbe,
    build_backend_service,
    build_model_stack,
)


def _config(payload: dict[str, Any]) -> AgentConfig:
    return AgentConfig.from_response(payload)


def _tool(name: str = "lookup_invoice") -> FunctionSchema:
    return FunctionSchema(
        name=name,
        description="Synthetic test tool.",
        properties={"email": {"type": "string"}},
        required=["email"],
        handler=None,
    )


def test_backend_service_uses_responses_settings_and_disables_timeout_retry(
    config_payload: dict[str, Any],
) -> None:
    config = _config(config_payload)

    service = build_backend_service(config, "test-openai-key")

    assert isinstance(service, OpenAIResponsesHttpLLMService)
    assert getattr(service._settings, "model") == config.backend_model  # noqa: B009, SLF001
    assert (  # noqa: SLF001
        getattr(service._settings, "system_instruction")  # noqa: B009
        == config.backend_instructions
    )
    assert service._function_call_timeout_secs == config.function_call_timeout_secs  # noqa: SLF001
    assert service._retry_on_timeout is False  # noqa: SLF001


def test_model_stack_keeps_tools_in_exactly_one_backend_context(
    config_payload: dict[str, Any],
) -> None:
    config = _config(config_payload)
    tools = [_tool("lookup_invoice"), _tool("restart_server")]
    backend_service = build_backend_service(config, "test-openai-key")

    models = build_model_stack(
        config,
        "test-openai-key",
        tools,
        backend_service=backend_service,
    )

    assert models.backend_service is backend_service
    backend_tools = cast(ToolsSchema, models.backend_context.tools)
    assert backend_tools.standard_tools == tools
    assert models.voice_context.tools is NOT_GIVEN
    assert isinstance(models.voice_service._delegation, OpenAILiveLLMService.ClientDelegation)  # noqa: SLF001
    assert models.voice_service._delegation.backend is models.backend_worker  # noqa: SLF001
    assert models.backend_worker._context is models.backend_context  # noqa: SLF001
    assert [tool.name for tool in backend_tools.standard_tools] == [
        "lookup_invoice",
        "restart_server",
    ]
    assert PROBE_TOOL_NAME not in [
        tool.name for tool in backend_tools.standard_tools
    ]


async def test_real_voice_service_path_serializes_client_delegation_with_zero_authority(
    config_payload: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config = _config(config_payload)
    tools = [_tool()]
    models = build_model_stack(config, "agent-token-canary-never-reach-voice", tools)
    captured: list[live_events.ClientEvent] = []

    async def capture(event: live_events.ClientEvent) -> None:
        captured.append(event)

    monkeypatch.setattr(models.voice_service, "send_client_event", capture)
    models.voice_service._context = models.voice_context  # noqa: SLF001

    await models.voice_service._send_session_config()  # type: ignore[no-untyped-call]  # noqa: SLF001

    assert len(captured) == 1
    assert isinstance(captured[0], live_events.SessionStartEvent)
    payload = captured[0].to_payload()
    serialized = json.dumps(payload, separators=(",", ":"))
    expected_instructions = compose_instructions(
        config.instructions,
        config.accent_style,
        config.waiting_behavior,
    )
    assert payload["session"]["instructions"] == expected_instructions
    assert payload["session"]["delegation"] == {"type": "client"}
    assert "tools" not in serialized
    assert '"responses"' not in serialized
    assert config.backend_instructions not in serialized
    assert config.server_secret not in serialized
    assert "agent-token-canary-never-reach-voice" not in serialized
    assert "lookup_invoice" not in serialized


class FakeResponsesCreate:
    def __init__(self, response: object | BaseException) -> None:
        self.response = response
        self.calls: list[dict[str, Any]] = []

    async def create(self, **kwargs: Any) -> object:
        self.calls.append(kwargs)
        if isinstance(self.response, BaseException):
            raise self.response
        return self.response


def _probe_service(create: FakeResponsesCreate) -> OpenAIResponsesHttpLLMService:
    return cast(
        OpenAIResponsesHttpLLMService,
        SimpleNamespace(_client=SimpleNamespace(responses=create)),
    )


async def test_boot_probe_forces_exact_local_tool_through_responses_api() -> None:
    create = FakeResponsesCreate(
        SimpleNamespace(
            output=[SimpleNamespace(type="function_call", name=PROBE_TOOL_NAME)]
        )
    )

    await ResponsesToolProbe().verify(_probe_service(create), "gpt-test-responses")

    assert len(create.calls) == 1
    request = create.calls[0]
    assert request["model"] == "gpt-test-responses"
    assert request["tool_choice"] == {"type": "function", "name": PROBE_TOOL_NAME}
    assert request["tools"] == [
        {
            "type": "function",
            "name": PROBE_TOOL_NAME,
            "description": "Confirm that this model supports Responses function tools.",
            "parameters": {
                "type": "object",
                "properties": {"ok": {"type": "boolean"}},
                "required": ["ok"],
                "additionalProperties": False,
            },
            "strict": True,
        }
    ]
    assert PROBE_TIMEOUT_SECS == 10.0


@pytest.mark.parametrize(
    "response",
    [
        pytest.param(RuntimeError("provider rejected tools"), id="provider-error"),
        pytest.param(SimpleNamespace(output=[]), id="answer-without-tool-call"),
        pytest.param(
            SimpleNamespace(output=[SimpleNamespace(type="function_call", name="wrong_tool")]),
            id="wrong-tool-call",
        ),
        pytest.param(SimpleNamespace(output=None), id="malformed-output"),
    ],
)
async def test_boot_probe_fails_loudly_and_names_model_for_every_invalid_outcome(
    response: object | BaseException,
) -> None:
    create = FakeResponsesCreate(response)

    with pytest.raises(BackendProbeError, match="gpt-test-responses"):
        await ResponsesToolProbe().verify(_probe_service(create), "gpt-test-responses")


async def test_boot_probe_timeout_is_fatal_and_names_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class NeverResponds:
        async def create(self, **kwargs: Any) -> object:
            del kwargs
            import asyncio

            await asyncio.Event().wait()
            raise AssertionError("unreachable")

    monkeypatch.setattr("duplexd_agent.provider.PROBE_TIMEOUT_SECS", 0.01)
    service = cast(
        OpenAIResponsesHttpLLMService,
        SimpleNamespace(_client=SimpleNamespace(responses=NeverResponds())),
    )

    with pytest.raises(BackendProbeError, match="gpt-test-responses"):
        await ResponsesToolProbe().verify(service, "gpt-test-responses")
