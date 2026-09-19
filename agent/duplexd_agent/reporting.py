"""Best-effort production telemetry for one call.

Event vocabulary and payloads:

* ``bot_speech_started`` / ``bot_speech_stopped``: empty payload.
* ``tool_started``: ``tool``, ``invocationId``.
* ``tool_finished``: ``tool``, ``invocationId``, ``outcome``, ``durationMs``
  and optional ``status`` / ``errorCategory``.
* ``delegation_created``: ``delegationId``.
* ``transcript_user`` / ``transcript_assistant``: ``text``.
* ``interruption``: empty payload.

Every stored event has ``seq``, RFC 3339 ``at``, ``type``, and ``payload``.
Failures never escape into the conversation pipeline.
"""

from __future__ import annotations

import asyncio
import time
from datetime import UTC, datetime
from typing import Any, Protocol

from loguru import logger
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    InterruptionFrame,
)
from pipecat.observers.base_observer import BaseObserver, FramePushed

from duplexd_agent.platform import REPORTING_TIMEOUT_SECS, encode_json

EVENT_TYPES = frozenset(
    {
        "bot_speech_started",
        "bot_speech_stopped",
        "tool_started",
        "tool_finished",
        "delegation_created",
        "transcript_user",
        "transcript_assistant",
        "interruption",
    }
)
END_REASONS = frozenset({"client_disconnected", "pipeline_error", "idle_timeout"})


class ReportingTransport(Protocol):
    async def post_events(self, body: bytes) -> bool: ...

    async def post_complete(self, body: bytes) -> bool: ...


class EventReporter:
    def __init__(
        self,
        transport: ReportingTransport,
        *,
        flush_interval_secs: float = 3.0,
    ) -> None:
        self._transport = transport
        self._flush_interval_secs = flush_interval_secs
        self._next_seq = 1
        self._pending: list[dict[str, Any]] = []
        self._lock = asyncio.Lock()
        self._flush_lock = asyncio.Lock()
        self._stop_event = asyncio.Event()
        self._periodic_task: asyncio.Task[None] | None = None

    async def start(self) -> None:
        if self._periodic_task is None:
            self._stop_event.clear()
            self._periodic_task = asyncio.create_task(self._run_periodically())

    async def stop(self) -> None:
        task = self._periodic_task
        self._periodic_task = None
        if task is not None:
            self._stop_event.set()
            await task

    async def record(self, event_type: str, payload: dict[str, Any]) -> None:
        if event_type not in EVENT_TYPES:
            raise ValueError(f"unknown call event type: {event_type}")
        async with self._lock:
            event = {
                "seq": self._next_seq,
                "at": datetime.now(UTC).isoformat(),
                "type": event_type,
                "payload": payload,
            }
            self._next_seq += 1
            self._pending.append(event)

    async def flush(self, *, heartbeat: bool = False) -> bool:
        async with self._flush_lock:
            async with self._lock:
                events = self._pending
                self._pending = []
            if not events and not heartbeat:
                return True
            body = encode_json({"events": events})
            for _attempt in range(2):
                try:
                    succeeded = await asyncio.wait_for(
                        self._transport.post_events(body),
                        timeout=REPORTING_TIMEOUT_SECS,
                    )
                except Exception:  # noqa: BLE001 - telemetry is non-fatal
                    succeeded = False
                if succeeded:
                    return True
            logger.warning("Call event reporting failed after one retry")
            return False

    async def complete(self, reason: str, duration_secs: float) -> bool:
        if reason not in END_REASONS:
            raise ValueError(f"unknown call end reason: {reason}")
        await self.flush()
        body = encode_json({"endedReason": reason, "durationSecs": round(duration_secs, 3)})
        try:
            succeeded = await asyncio.wait_for(
                self._transport.post_complete(body),
                timeout=REPORTING_TIMEOUT_SECS,
            )
        except Exception:  # noqa: BLE001 - completion failure is recorded upstream
            succeeded = False
        if not succeeded:
            logger.warning("Call completion reporting failed")
        return succeeded

    async def _run_periodically(self) -> None:
        while not self._stop_event.is_set():
            try:
                await asyncio.wait_for(
                    self._stop_event.wait(),
                    timeout=self._flush_interval_secs,
                )
                continue
            except TimeoutError:
                pass
            await self.flush(heartbeat=True)


class ReportingObserver(BaseObserver):
    """Observe each speech/interruption frame once across processor hops."""

    def __init__(self, reporter: EventReporter) -> None:
        super().__init__()
        self._reporter = reporter
        self._seen: set[int] = set()

    async def on_push_frame(self, data: FramePushed) -> None:
        frame = data.frame
        if frame.id in self._seen:
            return
        self._seen.add(frame.id)
        if isinstance(frame, BotStartedSpeakingFrame):
            await self._reporter.record("bot_speech_started", {})
        elif isinstance(frame, BotStoppedSpeakingFrame):
            await self._reporter.record("bot_speech_stopped", {})
        elif isinstance(frame, InterruptionFrame):
            await self._reporter.record("interruption", {})


class NullEventReporter:
    """Useful only for local schema construction; it performs no I/O."""

    async def record(self, event_type: str, payload: dict[str, Any]) -> None:
        del event_type, payload


def monotonic_duration(started_at: float) -> float:
    return max(0.0, time.monotonic() - started_at)
