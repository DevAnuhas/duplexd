from __future__ import annotations

from types import SimpleNamespace
from typing import Any, cast

import pytest
from pipecat.transports.base_transport import BaseTransport

from duplexd_agent import runtime
from duplexd_agent.config import AgentConfig
from duplexd_agent.provider import ModelStack


class EventSource:
    def __init__(self) -> None:
        self.handlers: dict[str, Any] = {}

    def event_handler(self, name: str) -> Any:
        def register(handler: Any) -> Any:
            self.handlers[name] = handler
            return handler

        return register


class FakeTransport(EventSource):
    def input(self) -> object:
        return object()

    def output(self) -> object:
        return object()


class FakeWorker(EventSource):
    def __init__(self, *args: object, **kwargs: object) -> None:
        super().__init__()
        self.args = args
        self.kwargs = kwargs
        self.queued: list[object] = []

    async def queue_frames(self, frames: list[object]) -> None:
        self.queued.extend(frames)


class FakeReporter:
    def __init__(self) -> None:
        self.started = 0
        self.stopped = 0
        self.events: list[tuple[str, dict[str, Any]]] = []
        self.completions: list[tuple[str, float]] = []

    async def start(self) -> None:
        self.started += 1

    async def stop(self) -> None:
        self.stopped += 1

    async def record(self, event_type: str, payload: dict[str, Any]) -> None:
        self.events.append((event_type, payload))

    async def complete(self, reason: str, duration_secs: float) -> bool:
        self.completions.append((reason, duration_secs))
        return True


def _install_runtime_fakes(
    monkeypatch: pytest.MonkeyPatch,
    *,
    transport: FakeTransport,
    scenario: str,
) -> tuple[EventSource, EventSource, list[FakeWorker], list[Any]]:
    user_aggregator = EventSource()
    assistant_aggregator = EventSource()
    workers: list[FakeWorker] = []
    runners: list[Any] = []

    monkeypatch.setattr(
        runtime,
        "LLMContextAggregatorPair",
        lambda context: (user_aggregator, assistant_aggregator),
    )
    monkeypatch.setattr(
        runtime,
        "Pipeline",
        lambda processors: SimpleNamespace(processors=processors),
    )

    def worker_factory(*args: object, **kwargs: object) -> FakeWorker:
        worker = FakeWorker(*args, **kwargs)
        workers.append(worker)
        return worker

    monkeypatch.setattr(runtime, "PipelineWorker", worker_factory)
    monkeypatch.setattr(
        runtime,
        "ReportingObserver",
        lambda reporter: SimpleNamespace(reporter=reporter),
    )

    class FakeRunner:
        def __init__(self, *, handle_sigint: bool) -> None:
            self.handle_sigint = handle_sigint
            self.worker: FakeWorker | None = None
            self.cancelled = 0
            runners.append(self)

        async def add_workers(self, worker: FakeWorker) -> None:
            self.worker = worker

        async def cancel(self) -> None:
            self.cancelled += 1

        async def run(self) -> None:
            assert self.worker is not None
            if scenario == "client_disconnected":
                await transport.handlers["on_client_disconnected"](transport, object())
            elif scenario == "idle_timeout":
                await self.worker.handlers["on_idle_timeout"](self.worker)
            elif scenario == "pipeline_event":
                await self.worker.handlers["on_pipeline_error"](self.worker, object())
            elif scenario == "runner_exception":
                raise RuntimeError("pipeline exploded")
            elif scenario == "unobserved_stop":
                return
            else:
                raise AssertionError(f"unknown scenario {scenario}")

    monkeypatch.setattr(runtime, "WorkerRunner", FakeRunner)
    return user_aggregator, assistant_aggregator, workers, runners


def _models() -> ModelStack:
    return cast(
        ModelStack,
        SimpleNamespace(
            voice_context=object(),
            voice_service=EventSource(),
        ),
    )


def _runner_args() -> Any:
    return SimpleNamespace(pipeline_idle_timeout_secs=30.0, handle_sigint=False)


@pytest.mark.parametrize(
    ("scenario", "reason"),
    [
        ("client_disconnected", "client_disconnected"),
        ("idle_timeout", "idle_timeout"),
        ("pipeline_event", "pipeline_error"),
    ],
)
async def test_run_call_completes_only_with_the_observed_terminal_reason(
    monkeypatch: pytest.MonkeyPatch,
    config_payload: dict[str, Any],
    scenario: str,
    reason: str,
) -> None:
    transport = FakeTransport()
    _user, _assistant, workers, runners = _install_runtime_fakes(
        monkeypatch,
        transport=transport,
        scenario=scenario,
    )
    reporter = FakeReporter()

    await runtime.run_call(
        transport=cast(BaseTransport, transport),
        runner_args=_runner_args(),
        config=AgentConfig.from_response(config_payload),
        models=_models(),
        reporter=cast(Any, reporter),
    )

    assert reporter.started == 1
    assert reporter.stopped == 1
    assert len(reporter.completions) == 1
    assert reporter.completions[0][0] == reason
    assert reporter.completions[0][1] >= 0
    assert len(workers) == len(runners) == 1
    if scenario == "client_disconnected":
        assert runners[0].cancelled == 1


async def test_unobserved_process_stop_does_not_fabricate_clean_completion(
    monkeypatch: pytest.MonkeyPatch,
    config_payload: dict[str, Any],
) -> None:
    transport = FakeTransport()
    _install_runtime_fakes(monkeypatch, transport=transport, scenario="unobserved_stop")
    reporter = FakeReporter()

    await runtime.run_call(
        transport=cast(BaseTransport, transport),
        runner_args=_runner_args(),
        config=AgentConfig.from_response(config_payload),
        models=_models(),
        reporter=cast(Any, reporter),
    )

    assert reporter.started == reporter.stopped == 1
    assert reporter.completions == []


async def test_unhandled_pipeline_exception_reports_pipeline_error_then_reraises(
    monkeypatch: pytest.MonkeyPatch,
    config_payload: dict[str, Any],
) -> None:
    transport = FakeTransport()
    _install_runtime_fakes(monkeypatch, transport=transport, scenario="runner_exception")
    reporter = FakeReporter()

    with pytest.raises(RuntimeError, match="pipeline exploded"):
        await runtime.run_call(
            transport=cast(BaseTransport, transport),
            runner_args=_runner_args(),
            config=AgentConfig.from_response(config_payload),
            models=_models(),
            reporter=cast(Any, reporter),
        )

    assert [reason for reason, _duration in reporter.completions] == ["pipeline_error"]


async def test_runtime_event_handlers_emit_delegation_and_transcripts(
    monkeypatch: pytest.MonkeyPatch,
    config_payload: dict[str, Any],
) -> None:
    transport = FakeTransport()
    user, assistant, _workers, _runners = _install_runtime_fakes(
        monkeypatch,
        transport=transport,
        scenario="unobserved_stop",
    )
    models = _models()
    reporter = FakeReporter()

    await runtime.run_call(
        transport=cast(BaseTransport, transport),
        runner_args=_runner_args(),
        config=AgentConfig.from_response(config_payload),
        models=models,
        reporter=cast(Any, reporter),
    )

    await cast(EventSource, models.voice_service).handlers["on_delegation_created"](
        models.voice_service,
        SimpleNamespace(id="delegation-1"),
    )
    await user.handlers["on_user_turn_message_added"](
        user,
        SimpleNamespace(content="hello"),
    )
    await assistant.handlers["on_assistant_turn_stopped"](
        assistant,
        SimpleNamespace(content="goodbye"),
    )

    assert reporter.events == [
        ("delegation_created", {"delegationId": "delegation-1"}),
        ("transcript_user", {"text": "hello"}),
        ("transcript_assistant", {"text": "goodbye"}),
    ]


@pytest.mark.parametrize("voice_first", [False, True])
async def test_sandbox_readiness_requires_both_actual_callbacks_and_greeting_is_browser_first_once(
    monkeypatch: pytest.MonkeyPatch,
    config_payload: dict[str, Any],
    voice_first: bool,
) -> None:
    from test_sandbox import control

    transport = FakeTransport()
    _, _, workers, _ = _install_runtime_fakes(
        monkeypatch,
        transport=transport,
        scenario="unobserved_stop",
    )
    models = _models()
    reporter = FakeReporter()
    watchdog = runtime.SandboxWatchdog(
        cast(Any, SimpleNamespace(control_received_at=0.0)),
        control(),
        clock=lambda: 0.0,
    )

    async def run(_runner: Any) -> None:
        # Browser connects before either actual media callback. It gets one greeting.
        await transport.handlers["on_client_connected"](transport, object())
        await transport.handlers["on_client_connected"](transport, object())
        assert len(workers[0].queued) == 1
        assert reporter.events == [] and not watchdog.ready
        callbacks = [
            (transport.handlers["on_connected"], transport),
            (
                cast(EventSource, models.voice_service).handlers["on_session_started"],
                models.voice_service,
            ),
        ]
        if voice_first:
            callbacks.reverse()
        await callbacks[0][0](callbacks[0][1], object())
        assert reporter.events == [] and not watchdog.ready
        await callbacks[1][0](callbacks[1][1], object())
        await callbacks[0][0](callbacks[0][1], object())
        await callbacks[1][0](callbacks[1][1], object())
        assert reporter.events == [("agent_ready", {})] and watchdog.ready
        assert len(workers[0].queued) == 1

    monkeypatch.setattr(cast(Any, runtime).WorkerRunner, "run", run)
    await runtime.run_call(
        transport=cast(BaseTransport, transport),
        runner_args=_runner_args(),
        config=AgentConfig.from_response(config_payload),
        models=models,
        reporter=cast(Any, reporter),
        watchdog=watchdog,
    )
    assert watchdog.reason is None  # A runner returning is not an observed call ending.
    assert reporter.completions == []


async def test_sandbox_late_callbacks_cannot_revive_expired_execution(
    monkeypatch: pytest.MonkeyPatch,
    config_payload: dict[str, Any],
) -> None:
    from test_sandbox import control

    transport = FakeTransport()
    _, _, workers, _ = _install_runtime_fakes(
        monkeypatch, transport=transport, scenario="unobserved_stop"
    )
    models = _models()
    reporter = FakeReporter()
    clock = [0.0]
    watchdog = runtime.SandboxWatchdog(
        cast(Any, SimpleNamespace(control_received_at=0.0)),
        control(),
        clock=lambda: clock[0],
    )

    async def run(_runner: Any) -> None:
        clock[0] = 30.0
        await transport.handlers["on_connected"](transport, object())
        await cast(EventSource, models.voice_service).handlers["on_session_started"](
            models.voice_service, object()
        )
        await transport.handlers["on_client_connected"](transport, object())

    monkeypatch.setattr(cast(Any, runtime).WorkerRunner, "run", run)
    await runtime.run_call(
        transport=cast(BaseTransport, transport),
        runner_args=_runner_args(),
        config=AgentConfig.from_response(config_payload),
        models=models,
        reporter=cast(Any, reporter),
        watchdog=watchdog,
    )
    assert watchdog.reason == "control_lost"
    assert reporter.events == [] and workers[0].queued == [] and not watchdog.ready
