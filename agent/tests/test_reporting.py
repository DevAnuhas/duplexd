from __future__ import annotations

import asyncio
import json
from typing import Any, cast

import pytest
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    InterruptionFrame,
)
from pipecat.observers.base_observer import FramePushed
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

from duplexd_agent import reporting
from duplexd_agent.reporting import END_REASONS, EVENT_TYPES, EventReporter, ReportingObserver


class StatefulReportingStub:
    def __init__(
        self,
        *,
        first_events_response: bool = True,
        permanent_events_failure: bool = False,
        completion_response: bool = True,
    ) -> None:
        self.first_events_response = first_events_response
        self.permanent_events_failure = permanent_events_failure
        self.completion_response = completion_response
        self.event_bodies: list[bytes] = []
        self.complete_bodies: list[bytes] = []
        self.rows: dict[int, dict[str, Any]] = {}

    async def post_events(self, body: bytes) -> bool:
        self.event_bodies.append(body)
        payload = json.loads(body)
        for event in payload["events"]:
            self.rows.setdefault(event["seq"], event)
        if self.permanent_events_failure:
            return False
        if len(self.event_bodies) == 1:
            return self.first_events_response
        return True

    async def post_complete(self, body: bytes) -> bool:
        self.complete_bodies.append(body)
        return self.completion_response


async def test_failed_batch_retries_once_with_identical_bytes_and_same_sequences() -> None:
    transport = StatefulReportingStub(first_events_response=False)
    reporter = EventReporter(transport)
    await reporter.record("bot_speech_started", {})
    await reporter.record("transcript_user", {"text": "hello"})

    assert await reporter.flush() is True

    assert len(transport.event_bodies) == 2
    assert transport.event_bodies[0] == transport.event_bodies[1]
    events = json.loads(transport.event_bodies[0])["events"]
    assert [event["seq"] for event in events] == [1, 2]
    assert sorted(transport.rows) == [1, 2]
    assert len(transport.rows) == 2


async def test_sequences_increase_across_batches_and_terminal_flush_precedes_completion() -> None:
    transport = StatefulReportingStub()
    reporter = EventReporter(transport)

    await reporter.record("bot_speech_started", {})
    await reporter.flush()
    await reporter.record("bot_speech_stopped", {})
    await reporter.record("transcript_assistant", {"text": "goodbye"})

    assert await reporter.complete("client_disconnected", 12.3456) is True

    assert len(transport.event_bodies) == 2
    all_events = [
        event
        for body in transport.event_bodies
        for event in json.loads(body)["events"]
    ]
    assert [event["seq"] for event in all_events] == [1, 2, 3]
    assert len(set(transport.rows)) == len(transport.rows) == 3
    assert len(transport.complete_bodies) == 1
    assert json.loads(transport.complete_bodies[0]) == {
        "endedReason": "client_disconnected",
        "durationSecs": 12.346,
    }


@pytest.mark.parametrize("reason", sorted(END_REASONS))
async def test_completion_preserves_each_documented_end_reason(reason: str) -> None:
    transport = StatefulReportingStub()
    reporter = EventReporter(transport)

    assert await reporter.complete(reason, 1.0) is True

    assert json.loads(transport.complete_bodies[0])["endedReason"] == reason


async def test_completion_failure_cannot_rewrite_observed_reason() -> None:
    transport = StatefulReportingStub(completion_response=False)
    reporter = EventReporter(transport)

    assert await reporter.complete("pipeline_error", 2.0) is False

    assert len(transport.complete_bodies) == 1
    assert json.loads(transport.complete_bodies[0])["endedReason"] == "pipeline_error"


async def test_permanent_event_failure_does_not_suppress_completion_attempt() -> None:
    transport = StatefulReportingStub(permanent_events_failure=True)
    reporter = EventReporter(transport)
    await reporter.record("transcript_user", {"text": "still talking"})

    assert await reporter.complete("idle_timeout", 30.0) is True

    assert len(transport.event_bodies) == 2
    assert transport.event_bodies[0] == transport.event_bodies[1]
    assert len(transport.complete_bodies) == 1
    assert json.loads(transport.complete_bodies[0])["endedReason"] == "idle_timeout"


async def test_event_endpoint_that_never_answers_is_bounded_and_completion_is_attempted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    completion_attempted = asyncio.Event()

    class NeverAnsweringTransport:
        async def post_events(self, body: bytes) -> bool:
            del body
            await asyncio.Event().wait()
            return True

        async def post_complete(self, body: bytes) -> bool:
            del body
            completion_attempted.set()
            return True

    monkeypatch.setattr(reporting, "REPORTING_TIMEOUT_SECS", 0.01)
    reporter = EventReporter(NeverAnsweringTransport())
    await reporter.record("interruption", {})

    assert await reporter.complete("client_disconnected", 1.0) is True
    assert completion_attempted.is_set()


def test_documented_event_and_completion_vocabularies_are_exact() -> None:
    assert EVENT_TYPES == {
        "bot_speech_started",
        "bot_speech_stopped",
        "tool_started",
        "tool_finished",
        "delegation_created",
        "transcript_user",
        "transcript_assistant",
        "interruption",
    }
    assert END_REASONS == {"client_disconnected", "pipeline_error", "idle_timeout"}
    module_doc = reporting.__doc__ or ""
    for event_type in EVENT_TYPES:
        assert f"``{event_type}``" in module_doc


async def test_reporting_observer_deduplicates_frames_across_processor_hops() -> None:
    transport = StatefulReportingStub()
    reporter = EventReporter(transport)
    observer = ReportingObserver(reporter)
    frames = [BotStartedSpeakingFrame(), BotStoppedSpeakingFrame(), InterruptionFrame()]

    for frame in frames:
        pushed = FramePushed(
            source=cast(FrameProcessor, None),
            destination=cast(FrameProcessor, None),
            frame=frame,
            direction=FrameDirection.DOWNSTREAM,
            timestamp=0,
        )
        await observer.on_push_frame(pushed)
        await observer.on_push_frame(pushed)

    await reporter.flush()
    emitted = json.loads(transport.event_bodies[0])["events"]
    assert [event["type"] for event in emitted] == [
        "bot_speech_started",
        "bot_speech_stopped",
        "interruption",
    ]
