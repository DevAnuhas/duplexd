from __future__ import annotations

from types import SimpleNamespace
from typing import Any, cast

import pytest
from loguru import logger
from pipecat.runner.types import RunnerArguments
from pipecat.services.openai.responses.llm import OpenAIResponsesHttpLLMService
from pipecat.transports.base_transport import BaseTransport, TransportParams

from duplexd_agent import bot as bot_module
from duplexd_agent.config import AgentConfig, RunnerInput
from duplexd_agent.errors import AgentStartupError, BackendProbeError, RunnerInputError


def _runner_args(body: object) -> RunnerArguments:
    return cast(
        RunnerArguments,
        SimpleNamespace(
            body=body,
            pipeline_idle_timeout_secs=30.0,
            handle_sigint=False,
        ),
    )


class FakePlatform:
    def __init__(self, config: AgentConfig) -> None:
        self.config = config
        self.fetches = 0
        self.closed = False

    async def __aenter__(self) -> FakePlatform:
        return self

    async def __aexit__(self, *args: object) -> None:
        self.closed = True

    async def fetch_config(self) -> AgentConfig:
        self.fetches += 1
        return self.config

    async def post_events(self, body: bytes) -> bool:
        del body
        return True

    async def post_complete(self, body: bytes) -> bool:
        del body
        return True


class FakeProbe:
    def __init__(self, error: BaseException | None = None) -> None:
        self.error = error
        self.calls: list[tuple[OpenAIResponsesHttpLLMService, str]] = []

    async def verify(
        self, service: OpenAIResponsesHttpLLMService, model: str
    ) -> None:
        self.calls.append((service, model))
        if self.error is not None:
            raise self.error


@pytest.mark.parametrize("key", ["callId", "apiBase", "agentToken"])
@pytest.mark.parametrize("bad_value", [pytest.param(None, id="missing"), "", 42])
async def test_fatal_runner_args_stop_before_platform_http_probe_or_transport(
    monkeypatch: pytest.MonkeyPatch,
    runner_body: dict[str, str],
    key: str,
    bad_value: object,
) -> None:
    body: dict[str, object] = dict(runner_body)
    if bad_value is None:
        body.pop(key)
    else:
        body[key] = bad_value
    platform_factory_calls: list[RunnerInput] = []
    transport_calls: list[object] = []
    probe = FakeProbe()

    def platform_factory(runner_input: RunnerInput) -> Any:
        platform_factory_calls.append(runner_input)
        raise AssertionError("platform must not be constructed")

    async def transport_factory(
        args: RunnerArguments, params: dict[str, Any]
    ) -> BaseTransport:
        transport_calls.append((args, params))
        raise AssertionError("transport must not be constructed")

    monkeypatch.setenv("OPENAI_API_KEY", "test-key")

    with pytest.raises(RunnerInputError, match=key):
        await bot_module.bootstrap(
            _runner_args(body),
            platform_client_factory=platform_factory,
            probe=probe,
            transport_factory=transport_factory,
        )

    assert platform_factory_calls == []
    assert probe.calls == []
    assert transport_calls == []

    logs: list[str] = []
    sink = logger.add(lambda message: logs.append(str(message)), level="DEBUG")
    try:
        with pytest.raises(RunnerInputError, match=key):
            await bot_module.bot(_runner_args(body))
    finally:
        logger.remove(sink)
    joined_logs = "".join(logs)
    assert key in joined_logs
    assert runner_body["agentToken"] not in joined_logs


async def test_missing_provider_key_stops_before_platform_fetch_and_transport(
    monkeypatch: pytest.MonkeyPatch,
    runner_body: dict[str, str],
) -> None:
    factory_calls: list[RunnerInput] = []
    transport_calls: list[object] = []

    def platform_factory(runner_input: RunnerInput) -> Any:
        factory_calls.append(runner_input)
        raise AssertionError("platform must not be constructed")

    async def transport_factory(
        args: RunnerArguments, params: dict[str, Any]
    ) -> BaseTransport:
        transport_calls.append((args, params))
        raise AssertionError("transport must not be constructed")

    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    with pytest.raises(AgentStartupError, match="OPENAI_API_KEY"):
        await bot_module.bootstrap(
            _runner_args(runner_body),
            platform_client_factory=platform_factory,
            transport_factory=transport_factory,
        )

    assert factory_calls == []
    assert transport_calls == []


async def test_successful_boot_fetches_once_probes_before_transport_and_uses_same_backend_path(
    monkeypatch: pytest.MonkeyPatch,
    runner_body: dict[str, str],
    config_payload: dict[str, Any],
) -> None:
    config = AgentConfig.from_response(config_payload)
    platform = FakePlatform(config)
    order: list[str] = []
    factory_inputs: list[RunnerInput] = []

    def platform_factory(runner_input: RunnerInput) -> Any:
        factory_inputs.append(runner_input)
        return platform

    class OrderedProbe(FakeProbe):
        async def verify(
            self, service: OpenAIResponsesHttpLLMService, model: str
        ) -> None:
            order.append("probe")
            await super().verify(service, model)

    probe = OrderedProbe()
    fake_transport = cast(BaseTransport, object())

    async def transport_factory(
        args: RunnerArguments,
        params: dict[str, Any],
    ) -> BaseTransport:
        del args
        order.append("transport")
        assert set(params) == {"daily", "webrtc"}
        assert all(isinstance(factory(), TransportParams) for factory in params.values())
        return fake_transport

    async def run_call(**kwargs: Any) -> None:
        order.append("run")
        assert kwargs["transport"] is fake_transport
        assert kwargs["config"] is config
        models = kwargs["models"]
        assert models.backend_service is probe.calls[0][0]

    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setattr(bot_module, "run_call", run_call)

    await bot_module.bootstrap(
        _runner_args(runner_body),
        platform_client_factory=platform_factory,
        probe=probe,
        transport_factory=transport_factory,
    )

    assert len(factory_inputs) == 1
    assert factory_inputs[0].call_id == runner_body["callId"]
    assert platform.fetches == 1
    assert platform.closed is True
    assert order == ["probe", "transport", "run"]
    assert len(probe.calls) == 1
    assert probe.calls[0][1] == config.backend_model
    assert isinstance(probe.calls[0][0], OpenAIResponsesHttpLLMService)


async def test_probe_failure_aborts_before_transport_creation_and_webhook_delivery(
    monkeypatch: pytest.MonkeyPatch,
    runner_body: dict[str, str],
    config_payload: dict[str, Any],
) -> None:
    config = AgentConfig.from_response(config_payload)
    platform = FakePlatform(config)
    probe = FakeProbe(BackendProbeError(f"backend model {config.backend_model} rejected probe"))
    transport_calls: list[object] = []

    def platform_factory(runner_input: RunnerInput) -> Any:
        del runner_input
        return platform

    async def transport_factory(
        args: RunnerArguments, params: dict[str, Any]
    ) -> BaseTransport:
        transport_calls.append((args, params))
        raise AssertionError("transport must not be constructed")

    class RejectWebhookUse:
        async def send(self, **kwargs: Any) -> Any:
            raise AssertionError(f"probe must not contact customer webhook: {kwargs}")

    monkeypatch.setenv("OPENAI_API_KEY", "test-key")

    with pytest.raises(BackendProbeError, match=config.backend_model):
        await bot_module.bootstrap(
            _runner_args(runner_body),
            platform_client_factory=platform_factory,
            probe=probe,
            transport_factory=transport_factory,
            webhook_connector=cast(Any, RejectWebhookUse()),
        )

    assert platform.fetches == 1
    assert len(probe.calls) == 1
    assert transport_calls == []
