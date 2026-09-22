"""Pipecat pipeline wiring for one fetched call configuration."""

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from pipecat.frames.frames import ErrorFrame, LLMRunFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker, ProcessorUnusablePolicy
from pipecat.processors.aggregators.llm_response_universal import (
    AssistantTurnStoppedMessage,
    LLMContextAggregatorPair,
    UserTurnMessageAddedMessage,
)
from pipecat.transports.base_transport import BaseTransport
from pipecat.workers.runner import WorkerRunner

from duplexd_agent.config import SANDBOX_END_REASONS, AgentConfig, SandboxControl
from duplexd_agent.errors import RuntimeShutdownError
from duplexd_agent.platform import PlatformClient
from duplexd_agent.provider import ModelStack
from duplexd_agent.reporting import EventReporter, ReportingObserver

SHUTDOWN_TIMEOUT_SECS = 10.0


async def _shutdown_owned_runner(runner: WorkerRunner) -> None:
    """Pipecat 1.11.0: cancel() only signals; run() can unwind during setup.

    Reuse its one root/child cancellation-and-join primitive even when startup
    never reached run's cleanup guard. Keep the real-runner startup regression
    when upgrading the pin; remove this private hook once SDK teardown covers
    partial setup through a public awaited shutdown API.
    """
    try:
        async with asyncio.timeout(SHUTDOWN_TIMEOUT_SECS):
            await runner._cancel_spawned_workers()
            await runner.cleanup()  # type: ignore[no-untyped-call]  # SDK 1.11
            await runner.bus.stop()  # type: ignore[no-untyped-call]  # SDK 1.11
            if any(not task.done() for task in runner.task_manager.current_tasks()):
                raise RuntimeShutdownError("runtime workers remain after teardown")
    except BaseException:
        # Includes a second cancellation interrupting teardown. A finished
        # supervisor is not evidence that its workers/media have stopped.
        raise RuntimeShutdownError("runtime teardown could not be confirmed") from None


@dataclass
class ObservedEnd:
    reason: str | None = None


class SandboxWatchdog:
    """Independent monotonic leases: reporting or a slow probe cannot hold them open."""

    def __init__(
        self,
        platform: PlatformClient,
        control: SandboxControl,
        *,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.platform = platform
        self.clock = clock
        self.stopped = asyncio.Event()
        self.reason: str | None = None
        self.ready = False
        self.runner_stopped = True  # No runner is owned until run_call begins.
        self._deadlines: dict[str, float] = {}
        self._presence_expiry: float | None = None
        self._tasks: list[asyncio.Task[None]] = []
        self.update(control, platform.control_received_at)

    def request_stop(self, reason: str) -> None:
        if self.reason is None:
            self.reason = reason if reason in SANDBOX_END_REASONS else "pipeline_error"
            self.stopped.set()

    def check(self) -> None:
        if self.reason is not None:
            return
        due = [
            (at, reason)
            for reason, at in self._deadlines.items()
            if not (reason == "startup_deadline" and self.ready)
        ]
        if due:
            at, reason = min(due)
            if self.clock() >= at:
                self.request_stop(reason)

    def update(self, control: SandboxControl, request_started: float) -> None:
        # Evaluate OLD leases first. A response arriving after expiry cannot
        # resurrect execution; account for request latency conservatively.
        self.check()
        if self.reason is not None:
            return
        server_time = datetime.fromisoformat(control.serverTime.replace("Z", "+00:00")).timestamp()
        for reason, stamp in (
            ("startup_deadline", control.startupDeadline),
            ("execution_deadline", control.executionDeadline),
            ("presence_expired", control.presenceExpiresAt),
        ):
            absolute = datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp()
            deadline = request_started + absolute - server_time
            renewed_presence = reason == "presence_expired" and (
                self._presence_expiry is None or absolute > self._presence_expiry
            )
            if not renewed_presence and reason in self._deadlines:
                deadline = min(deadline, self._deadlines[reason])
            if reason == "presence_expired":
                self._presence_expiry = max(absolute, self._presence_expiry or absolute)
            self._deadlines[reason] = deadline
        self._deadlines["control_lost"] = request_started + 30.0
        if control.stopRequested:
            self.request_stop(control.stopReason or "user_stopped")
        self.check()

    async def start(self) -> None:
        self._tasks = [asyncio.create_task(self._poll()), asyncio.create_task(self._watch())]

    async def close(self) -> None:
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()

    async def _poll(self) -> None:
        while not self.stopped.is_set():
            try:
                control = await self.platform.poll_control()
                self.update(control, self.platform.control_received_at)
            except Exception:
                # Independent watchdog enforces the last accepted control lease.
                pass
            await asyncio.sleep(3.0)

    async def _watch(self) -> None:
        while not self.stopped.is_set():
            self.check()
            await asyncio.sleep(0.1)


async def run_call(
    *,
    transport: BaseTransport,
    runner_args: Any,
    config: AgentConfig,
    models: ModelStack,
    reporter: EventReporter,
    watchdog: SandboxWatchdog | None = None,
) -> None:
    del config
    started_at = time.monotonic()
    observed_end = ObservedEnd()
    greeted = False
    room_connected = False
    voice_connected = False
    ready_sent = False

    async def ready_barrier() -> None:
        nonlocal ready_sent
        if watchdog is not None:
            watchdog.check()
            if (
                room_connected
                and voice_connected
                and not ready_sent
                and not watchdog.stopped.is_set()
            ):
                ready_sent = True
                watchdog.ready = True
                await reporter.record("agent_ready", {})

    user_aggregator, assistant_aggregator = LLMContextAggregatorPair(models.voice_context)
    pipeline = Pipeline(
        [
            transport.input(),
            user_aggregator,
            models.voice_service,
            transport.output(),
            assistant_aggregator,
        ]
    )
    worker = PipelineWorker(
        pipeline,
        params=PipelineParams(enable_metrics=True, enable_usage_metrics=True),
        idle_timeout_secs=runner_args.pipeline_idle_timeout_secs,
        observers=[ReportingObserver(reporter)],
        processor_unusable_policy=ProcessorUnusablePolicy.END,
    )
    runner = WorkerRunner(handle_sigint=runner_args.handle_sigint)
    if watchdog is not None:
        watchdog.runner_stopped = False

    @transport.event_handler("on_client_connected")  # type: ignore[misc]
    async def on_client_connected(_transport: BaseTransport, _client: Any) -> None:
        nonlocal greeted
        if watchdog:
            watchdog.check()
        if greeted or (watchdog and watchdog.stopped.is_set()):
            return
        greeted = True
        await worker.queue_frames([LLMRunFrame()])

    if watchdog is not None:

        @transport.event_handler("on_connected")  # type: ignore[misc]
        async def on_connected(_transport: BaseTransport, _data: Any) -> None:
            nonlocal room_connected
            room_connected = True
            await ready_barrier()

        @models.voice_service.event_handler("on_session_started")  # type: ignore[misc]
        async def on_session_started(_service: Any, _session: Any) -> None:
            nonlocal voice_connected
            voice_connected = True
            await ready_barrier()

    @transport.event_handler("on_client_disconnected")  # type: ignore[misc]
    async def on_client_disconnected(_transport: BaseTransport, _client: Any) -> None:
        observed_end.reason = "client_disconnected"
        await runner.cancel()

    @worker.event_handler("on_idle_timeout")  # type: ignore[misc]
    async def on_idle_timeout(_worker: PipelineWorker) -> None:
        observed_end.reason = "idle_timeout"

    @worker.event_handler("on_pipeline_error")  # type: ignore[misc]
    async def on_pipeline_error(_worker: PipelineWorker, _frame: ErrorFrame) -> None:
        observed_end.reason = "pipeline_error"

    @models.voice_service.event_handler("on_delegation_created")  # type: ignore[misc]
    async def on_delegation_created(_llm: Any, delegation: Any) -> None:
        await reporter.record(
            "delegation_created",
            {"delegationId": getattr(delegation, "id", None)},
        )

    @user_aggregator.event_handler("on_user_turn_message_added")  # type: ignore[misc]
    async def on_user_turn(_aggregator: Any, message: UserTurnMessageAddedMessage) -> None:
        await reporter.record("transcript_user", {"text": message.content})

    @assistant_aggregator.event_handler("on_assistant_turn_stopped")  # type: ignore[misc]
    async def on_assistant_turn(_aggregator: Any, message: AssistantTurnStoppedMessage) -> None:
        await reporter.record("transcript_assistant", {"text": message.content})

    await reporter.start()
    failure: BaseException | None = None
    try:
        await runner.add_workers(worker)
        await runner.run()
    except asyncio.CancelledError:
        raise
    except BaseException as error:
        observed_end.reason = "pipeline_error"
        failure = error
    finally:
        if watchdog is not None:
            await _shutdown_owned_runner(runner)
            watchdog.runner_stopped = True
            if observed_end.reason is not None:
                watchdog.request_stop(observed_end.reason)
        else:
            await reporter.stop()
            if observed_end.reason is not None:
                await reporter.complete(observed_end.reason, time.monotonic() - started_at)
    if failure is not None:
        raise failure
