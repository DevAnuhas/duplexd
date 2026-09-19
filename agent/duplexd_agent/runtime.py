"""Pipecat pipeline wiring for one fetched call configuration."""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
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

from duplexd_agent.config import AgentConfig
from duplexd_agent.provider import ModelStack
from duplexd_agent.reporting import EventReporter, ReportingObserver


@dataclass
class ObservedEnd:
    reason: str | None = None


async def run_call(
    *,
    transport: BaseTransport,
    runner_args: Any,
    config: AgentConfig,
    models: ModelStack,
    reporter: EventReporter,
) -> None:
    del config
    started_at = time.monotonic()
    observed_end = ObservedEnd()
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
    await runner.add_workers(worker)

    @transport.event_handler("on_client_connected")  # type: ignore[misc]
    async def on_client_connected(_transport: BaseTransport, _client: Any) -> None:
        await worker.queue_frames([LLMRunFrame()])

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
        await runner.run()
    except asyncio.CancelledError:
        raise
    except BaseException as error:
        observed_end.reason = "pipeline_error"
        failure = error
    finally:
        await reporter.stop()
        if observed_end.reason is not None:
            await reporter.complete(observed_end.reason, time.monotonic() - started_at)
    if failure is not None:
        raise failure
