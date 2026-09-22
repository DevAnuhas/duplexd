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
import copy
import time
from collections import deque
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any, Protocol

from loguru import logger
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    InterruptionFrame,
)
from pipecat.observers.base_observer import BaseObserver, FramePushed

from duplexd_agent.config import SANDBOX_END_REASONS, SandboxAck
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


class EvidenceTransport(Protocol):
    async def post_evidence(self, suffix: str, body: bytes) -> SandboxAck | None: ...


class EventReporter:
    def __init__(
        self,
        transport: ReportingTransport,
        *,
        flush_interval_secs: float = 3.0,
        evidence_transport: EvidenceTransport | None = None,
        request_stop: Callable[[str], None] | None = None,
    ) -> None:
        self._transport = transport
        self._flush_interval_secs = flush_interval_secs
        self._next_seq = 1
        self._pending: list[dict[str, Any]] = []
        self._lock = asyncio.Lock()
        self._flush_lock = asyncio.Lock()
        self._stop_event = asyncio.Event()
        self._periodic_task: asyncio.Task[None] | None = None
        self._evidence = evidence_transport
        self._request_stop = request_stop
        self._pending_bytes = 0
        self._total_bytes = 0
        self._producer_loss = False
        self._truncated = False
        self._sealed = False
        self._completion_body: bytes | None = None
        self._highest_sent = 0
        self._acknowledged = 0

    async def start(self) -> None:
        if self._periodic_task is None:
            self._stop_event.clear()
            self._periodic_task = asyncio.create_task(self._run_periodically())

    async def stop(self) -> None:
        task = self._periodic_task
        self._periodic_task = None
        if task is not None:
            self._stop_event.set()
            if task is not asyncio.current_task():
                await task

    async def record(self, event_type: str, payload: dict[str, Any]) -> None:
        if event_type not in EVENT_TYPES and not (self._evidence and event_type == "agent_ready"):
            raise ValueError(f"unknown call event type: {event_type}")
        async with self._lock:
            if self._sealed:
                return
            event = {
                "seq": self._next_seq,
                "at": datetime.now(UTC).isoformat(),
                "type": event_type,
                "payload": copy.deepcopy(payload),
            }
            if self._evidence:
                size = len(encode_json(event))
                if (
                    size > 8192
                    or self._next_seq > 10000
                    or self._total_bytes + size > 8388608
                    or len(self._pending) >= 1000
                    or self._pending_bytes + size > 2097152
                ):
                    self._producer_loss = True
                    self._truncated |= size > 8192
                    if self._request_stop:
                        self._request_stop("evidence_limit")
                    return
                self._pending_bytes += size
                self._total_bytes += size
            self._next_seq += 1
            self._pending.append(event)

    async def flush(self, *, heartbeat: bool = False) -> bool:
        async with self._flush_lock:
            if self._evidence:
                return await self._flush_evidence()
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
        if self._evidence:
            return await self._complete_evidence(reason, duration_secs)
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

    async def _flush_evidence(self) -> bool:
        assert self._evidence is not None
        async with self._lock:
            events: list[dict[str, Any]] = []
            size = 16
            for event in self._pending[:64]:
                event_size = len(encode_json(event)) + 1
                if size + event_size > 262144:
                    break
                events.append(event)
                size += event_size
            if not events:
                return True
            self._highest_sent = max(self._highest_sent, events[-1]["seq"])
            body = encode_json({"events": events})
        for _attempt in range(2):
            try:
                ack = await asyncio.wait_for(
                    self._evidence.post_evidence("events", body), REPORTING_TIMEOUT_SECS
                )
            except Exception:
                ack = None
            if ack is not None and self._acknowledged <= ack.contiguousSeq <= self._highest_sent:
                async with self._lock:
                    self._acknowledged = ack.contiguousSeq
                    self._pending = [
                        event for event in self._pending if event["seq"] > ack.contiguousSeq
                    ]
                    self._pending_bytes = sum(len(encode_json(event)) for event in self._pending)
                if ack.control.stopRequested and self._request_stop:
                    self._request_stop(ack.control.stopReason or "user_stopped")
                return True
        return False

    async def _complete_evidence(self, reason: str, duration_secs: float) -> bool:
        assert self._evidence is not None
        if reason not in SANDBOX_END_REASONS:
            raise ValueError("unsupported Sandbox end reason")
        async with self._lock:
            self._sealed = True
            if self._completion_body is None:
                self._completion_body = encode_json(
                    {
                        "endedReason": reason,
                        "durationSecs": round(max(0.0, duration_secs), 3),
                        "finalSeq": self._next_seq - 1,
                        "producerLoss": self._producer_loss,
                        "truncated": self._truncated,
                    }
                )
        # Costly work has already stopped. Neither sealing nor report retries
        # can restart it. Bound this drain below the server's reporting grace.
        completed = False
        try:
            async with asyncio.timeout(15.0):
                while True:
                    await self.flush()
                    ack = await self._evidence.post_evidence("complete", self._completion_body)
                    completed = ack is not None and ack.completionDigest is not None
                    if completed and not self._pending:
                        return True
                    await asyncio.sleep(0.25)
        except Exception:
            return completed

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
        self._seen_order: deque[int] = deque()

    async def on_push_frame(self, data: FramePushed) -> None:
        frame = data.frame
        if not isinstance(
            frame, (BotStartedSpeakingFrame, BotStoppedSpeakingFrame, InterruptionFrame)
        ):
            return
        if frame.id in self._seen:
            return
        self._seen.add(frame.id)
        self._seen_order.append(frame.id)
        if len(self._seen_order) > 2048:
            self._seen.discard(self._seen_order.popleft())
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
