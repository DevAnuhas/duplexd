"""Pinned WorkerRunner startup-cancellation regression; entirely synthetic media."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any, cast

import pytest
from pipecat.bus import WorkerBus
from pipecat.registry import WorkerRegistry
from pipecat.transports.base_transport import BaseTransport
from pipecat.workers.base_worker import BaseWorker, WorkerParams
from pipecat.workers.runner import WorkerRunner
from test_runtime import EventSource, FakeReporter, FakeTransport, _models, _runner_args
from test_sandbox import control

from duplexd_agent import runtime
from duplexd_agent.config import AgentConfig


async def test_actual_runner_startup_cancellation_joins_pipeline_and_child_before_return(
    monkeypatch: pytest.MonkeyPatch,
    config_payload: dict[str, Any],
) -> None:
    order: list[str] = []
    tasks: list[asyncio.Task[Any]] = []
    runners: list[WorkerRunner] = []
    watchdog = runtime.SandboxWatchdog(
        cast(Any, SimpleNamespace(control_received_at=0.0)),
        control(),
        clock=lambda: 0.0,
    )
    call_task: asyncio.Task[None]

    class SyntheticChild(BaseWorker):
        async def run(self, params: WorkerParams) -> None:
            task = asyncio.current_task()
            assert task is not None
            tasks.append(task)
            order.append("child_started")
            try:
                await super().run(params)
            finally:
                await asyncio.sleep(0)
                order.append("child_stopped")

    child = SyntheticChild(name="synthetic-startup-child")

    class SyntheticPipeline(BaseWorker):
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            super().__init__(name="synthetic-startup-pipeline")
            self._register_event_handler("on_idle_timeout")
            self._register_event_handler("on_pipeline_error")

        async def attach(
            self, *, registry: WorkerRegistry, bus: WorkerBus, worker_runner: WorkerRunner
        ) -> None:
            await super().attach(registry=registry, bus=bus, worker_runner=worker_runner)
            runners.append(worker_runner)
            # Exercise actual SDK parent-child cancellation propagation. Register before
            # run setup so both tasks exist when cancellation lands at root startup.
            await self.add_workers(child, watch=False)
            await worker_runner.add_workers(child)

        async def run(self, params: WorkerParams) -> None:
            task = asyncio.current_task()
            assert task is not None
            tasks.append(task)
            order.append("pipeline_started")
            # This is the task scheduled immediately before the pinned runner's
            # _start_worker sleep(0). Cancel its caller while still in _setup_session.
            assert not cast(Any, self.worker_runner)._running
            watchdog.request_stop("user_stopped")
            call_task.cancel()
            try:
                await super().run(params)
            finally:
                await asyncio.sleep(0)
                order.append("pipeline_stopped")

    monkeypatch.setattr(runtime, "PipelineWorker", SyntheticPipeline)
    monkeypatch.setattr(runtime, "Pipeline", lambda processors: processors)
    monkeypatch.setattr(
        runtime, "LLMContextAggregatorPair", lambda _: (EventSource(), EventSource())
    )
    monkeypatch.setattr(runtime, "ReportingObserver", lambda reporter: None)
    # Deliberately do not replace WorkerRunner: its real startup guard is the regression.
    reporter = FakeReporter()
    call_task = asyncio.create_task(
        runtime.run_call(
            transport=cast(BaseTransport, FakeTransport()),
            runner_args=_runner_args(),
            config=AgentConfig.from_response(config_payload),
            models=_models(),
            reporter=cast(Any, reporter),
            watchdog=watchdog,
        )
    )
    try:
        outcome = await asyncio.wait_for(asyncio.gather(call_task, return_exceptions=True), 1.0)
        order.append("run_call_returned")
        assert len(tasks) == 2 and order[:2] == ["child_started", "pipeline_started"]
        assert all(task.done() for task in tasks), f"owned worker survived run_call: {order}"
        assert order.index("child_stopped") < order.index("run_call_returned")
        assert order.index("pipeline_stopped") < order.index("run_call_returned")
        assert reporter.completions == []
        assert isinstance(outcome[0], asyncio.CancelledError)
        assert cast(Any, watchdog).runner_stopped is True
    finally:
        # RED must not strand its demonstrated leftovers in the test process.
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        for runner in runners:
            await cast(Any, runner.bus).stop()
            await cast(Any, runner).cleanup()


@pytest.mark.parametrize("failure", ["backend", "runner", "timeout", None])
async def test_bootstrap_seals_only_after_confirmed_runner_and_backend_cleanup(
    monkeypatch: pytest.MonkeyPatch,
    runner_body: dict[str, str],
    config_payload: dict[str, Any],
    failure: str | None,
) -> None:
    import time

    from test_bootstrap import FakePlatform, FakeProbe
    from test_bootstrap import _runner_args as bootstrap_args

    from duplexd_agent import bot as bot_module
    from duplexd_agent.config import SandboxConfig, SandboxOwner
    from duplexd_agent.errors import RuntimeShutdownError

    order: list[str] = []
    release_cleanup = asyncio.Event()
    owned_tasks: list[asyncio.Task[Any]] = []
    timeouts: list[float] = []
    original_wait = asyncio.wait

    async def measured_wait(*args: Any, **kwargs: Any) -> Any:
        if kwargs.get("timeout") is not None:
            timeouts.append(kwargs["timeout"])
        return await original_wait(*args, **kwargs)

    monkeypatch.setattr(bot_module, "SHUTDOWN_TIMEOUT_SECS", 0.01)
    monkeypatch.setattr(asyncio, "wait", measured_wait)

    class Platform(FakePlatform):
        control_received_at = time.monotonic()
        owner: SandboxOwner

        async def negotiate(self) -> str:
            return "sandbox-v1"

        async def register(self, owner: SandboxOwner) -> None:
            self.owner = owner

        async def claim_sandbox(self) -> SandboxConfig:
            return SandboxConfig(
                protocol="sandbox-v1", owner=self.owner, config=self.config, control=control()
            )

        async def poll_control(self) -> Any:
            await asyncio.Event().wait()

    class Client:
        async def close(self) -> None:
            order.append("backend_cleanup")
            if failure == "backend":
                raise RuntimeError("synthetic backend cleanup failure")
            order.append("backend_closed")

    class Reporter(FakeReporter):
        async def stop(self) -> None:
            order.append("reporter_stopped")
            await super().stop()

        async def complete(self, reason: str, duration_secs: float) -> bool:
            order.append("sealed")
            return await super().complete(reason, duration_secs)

    async def synthetic_call(**kwargs: Any) -> None:
        watchdog = kwargs["watchdog"]
        watchdog.runner_stopped = False
        watchdog.request_stop("user_stopped")
        order.append("runner_cleanup")
        if failure == "timeout":
            task = asyncio.current_task()
            assert task is not None
            owned_tasks.append(task)
            try:
                await asyncio.Event().wait()
            finally:
                order.append("cleanup_blocked")
                # Model SDK cleanup that does not finish merely because its
                # owner gets cancelled. The test releases this in its finally.
                while not release_cleanup.is_set():
                    try:
                        await release_cleanup.wait()
                    except asyncio.CancelledError:
                        order.append("cleanup_cancelled_again")
                watchdog.runner_stopped = True
                order.append("runner_stopped")
        if failure == "runner":
            raise RuntimeError("synthetic runner cleanup failure")
        watchdog.runner_stopped = True
        order.append("runner_stopped")

    async def transport_factory(*args: Any) -> Any:
        return FakeTransport()

    reporter = Reporter()
    platform = Platform(AgentConfig.from_response(config_payload))
    args = bootstrap_args(runner_body)
    args.session_id = "synthetic-cleanup-session"
    monkeypatch.setenv("OPENAI_API_KEY", "synthetic-offline-key")
    monkeypatch.setattr(
        bot_module, "build_backend_service", lambda *args: SimpleNamespace(_client=Client())
    )
    monkeypatch.setattr(bot_module, "build_model_stack", lambda *args, **kwargs: _models())
    monkeypatch.setattr(bot_module, "EventReporter", lambda *args, **kwargs: reporter)
    monkeypatch.setattr(bot_module, "run_call", synthetic_call)
    run = bot_module.bootstrap(
        args,
        platform_client_factory=lambda _: cast(Any, platform),
        probe=FakeProbe(),
        transport_factory=transport_factory,
    )
    if failure == "timeout":
        supervisor = asyncio.create_task(run)
        try:
            with pytest.raises(RuntimeShutdownError, match="exceeded its deadline"):
                await asyncio.wait_for(asyncio.shield(supervisor), 0.5)
            assert timeouts == [0.01], "shutdown must spend its budget once, including finally"
            assert order == ["runner_cleanup", "cleanup_blocked", "reporter_stopped"]
            assert len(owned_tasks) == 1 and not owned_tasks[0].done()
            assert reporter.completions == []
        finally:
            release_cleanup.set()
            await asyncio.gather(supervisor, *owned_tasks, return_exceptions=True)
        assert reporter.completions == []  # Later local cleanup cannot retroactively seal.
        assert order[-3:] == ["runner_stopped", "backend_cleanup", "backend_closed"]
    elif failure:
        with pytest.raises(RuntimeError, match=f"synthetic {failure} cleanup failure"):
            await asyncio.wait_for(run, 1.0)
        assert reporter.completions == [], f"unconfirmed cleanup sealed evidence: {order}"
        assert "sealed" not in order
    else:
        await asyncio.wait_for(run, 1.0)
        assert [reason for reason, _ in reporter.completions] == ["user_stopped"]
        assert order == [
            "runner_cleanup",
            "runner_stopped",
            "backend_cleanup",
            "backend_closed",
            "reporter_stopped",
            "sealed",
        ]
    assert platform.closed
