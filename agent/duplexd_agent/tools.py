"""Turn config schemas into Pipecat tools backed by one shared handler."""

from __future__ import annotations

import time
from collections.abc import Awaitable, Callable
from functools import partial
from typing import Any, Protocol

from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.services.llm_service import FunctionCallParams

from duplexd_agent.config import ToolDefinition
from duplexd_agent.webhooks import WebhookDispatcher


class EventSink(Protocol):
    async def record(self, event_type: str, payload: dict[str, Any]) -> None: ...


class SharedToolHandler:
    def __init__(
        self,
        dispatcher: WebhookDispatcher,
        event_sink: EventSink,
        *,
        monotonic: Callable[[], float] | None = None,
    ) -> None:
        self._dispatcher = dispatcher
        self._events = event_sink
        self._monotonic = monotonic or time.monotonic

    async def __call__(self, params: FunctionCallParams, *, tool_name: str) -> None:
        started = self._monotonic()
        invocation = self._dispatcher.new_invocation(tool_name, params.arguments)
        await self._events.record(
            "tool_started",
            {"tool": tool_name, "invocationId": invocation.invocation_id},
        )
        try:
            request = self._dispatcher.build_request(invocation)
            outcome = await self._dispatcher.deliver(request)
        except Exception:  # noqa: BLE001 - never escape into Pipecat's generic template
            from duplexd_agent.webhooks import WebhookOutcome

            outcome = WebhookOutcome(ok=False, error_code="webhook_internal_error")

        duration_ms = max(0, round((self._monotonic() - started) * 1000))
        payload: dict[str, Any] = {
            "tool": tool_name,
            "invocationId": invocation.invocation_id,
            "outcome": "success" if outcome.ok else "failure",
            "durationMs": duration_ms,
        }
        if outcome.status_code is not None:
            payload["status"] = outcome.status_code
        if outcome.error_code is not None:
            payload["errorCategory"] = outcome.error_code
        await self._events.record("tool_finished", payload)
        await params.result_callback(outcome.callback_value())


def build_tools(
    definitions: list[ToolDefinition],
    handler: SharedToolHandler,
) -> list[FunctionSchema]:
    tools: list[FunctionSchema] = []
    for definition in definitions:
        function = definition.function
        parameters = function.parameters
        bound_handler: Callable[[FunctionCallParams], Awaitable[None]] = partial(
            handler,
            tool_name=function.name,
        )
        tools.append(
            FunctionSchema(
                name=function.name,
                description=function.description,
                properties=parameters["properties"],
                required=parameters.get("required", []),
                handler=bound_handler,
            )
        )
    return tools
