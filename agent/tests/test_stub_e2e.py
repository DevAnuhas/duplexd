from __future__ import annotations

import json
import threading
from collections.abc import Iterator
from http.server import ThreadingHTTPServer
from typing import Any, cast

import pytest
from pipecat.services.llm_service import FunctionCallParams

from duplexd_agent.config import RunnerInput
from duplexd_agent.egress import EgressPolicy, HttpcorePinnedConnector
from duplexd_agent.platform import PlatformClient
from duplexd_agent.stub_server import (
    AGENT_TOKEN,
    ASSISTANT_ID,
    CALL_ID,
    SERVER_SECRET,
    StubHandler,
)
from duplexd_agent.tools import SharedToolHandler
from duplexd_agent.webhooks import WebhookDispatcher


@pytest.fixture
def live_stub() -> Iterator[tuple[str, ThreadingHTTPServer]]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), StubHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = cast(tuple[str, int], server.server_address)
    try:
        yield f"http://{host}:{port}", server
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


class RecordingEvents:
    def __init__(self) -> None:
        self.events: list[tuple[str, dict[str, Any]]] = []

    async def record(self, event_type: str, payload: dict[str, Any]) -> None:
        self.events.append((event_type, payload))


class Params:
    def __init__(self) -> None:
        self.arguments = {"key": "synthetic-key"}
        self.tool_call_id = "pipecat-tool-call"
        self.results: list[Any] = []

    async def result_callback(self, result: Any) -> None:
        self.results.append(result)


async def test_committed_stub_config_and_real_pinned_webhook_path(
    live_stub: tuple[str, ThreadingHTTPServer],
) -> None:
    api_base, _server = live_stub
    runner = RunnerInput.from_body(
        {"callId": CALL_ID, "apiBase": api_base, "agentToken": AGENT_TOKEN}
    )

    async with PlatformClient(runner) as platform:
        config = await platform.fetch_config()

    assert config.assistant_id == ASSISTANT_ID
    assert config.server_secret == SERVER_SECRET
    assert [tool.function.name for tool in config.tools] == ["sample_lookup"]

    dispatcher = WebhookDispatcher(
        server_url=f"{api_base}/webhook",
        server_secret=config.server_secret,
        call_id=CALL_ID,
        assistant_id=config.assistant_id,
        timeout_secs=config.webhook_timeout_secs,
        egress_policy=EgressPolicy(allow_local=True),
        connector=HttpcorePinnedConnector(),
        id_factory=lambda: "stub-e2e-invocation",
    )
    events = RecordingEvents()
    params = Params()

    await SharedToolHandler(dispatcher, events)(
        cast(FunctionCallParams, params),
        tool_name="sample_lookup",
    )

    assert params.results == [
        {
            "sample": True,
            "tool": "sample_lookup",
            "arguments": {"key": "synthetic-key"},
        }
    ]
    assert [event for event, _payload in events.events] == ["tool_started", "tool_finished"]
    assert events.events[-1][1]["outcome"] == "success"
    assert events.events[0][1]["invocationId"] == "stub-e2e-invocation"


async def test_stub_rejects_a_body_mutation_after_signature(
    live_stub: tuple[str, ThreadingHTTPServer],
) -> None:
    api_base, _server = live_stub
    dispatcher = WebhookDispatcher(
        server_url=f"{api_base}/webhook",
        server_secret=SERVER_SECRET,
        call_id=CALL_ID,
        assistant_id=ASSISTANT_ID,
        timeout_secs=1.0,
        egress_policy=EgressPolicy(allow_local=True),
        connector=HttpcorePinnedConnector(),
        id_factory=lambda: "stub-mutated-invocation",
    )
    invocation = dispatcher.new_invocation("sample_lookup", {"key": "before"})
    request = dispatcher.build_request(invocation)
    mutated = request.__class__(
        url=request.url,
        content=json.dumps(
            {
                "tool": "sample_lookup",
                "arguments": {"key": "after"},
                "callId": CALL_ID,
                "assistantId": ASSISTANT_ID,
                "invocationId": invocation.invocation_id,
            },
            separators=(",", ":"),
        ).encode(),
        headers=request.headers,
        invocation_id=request.invocation_id,
    )

    outcome = await dispatcher.deliver(mutated)

    assert outcome.ok is False
    assert outcome.status_code == 401
    assert outcome.error_code == "webhook_http_error"
