from __future__ import annotations

import hashlib
import hmac
import ipaddress
import json
from collections.abc import Iterator, Mapping
from typing import Any, cast

import pytest
from pipecat.services.llm_service import FunctionCallParams

from duplexd_agent.config import AgentConfig
from duplexd_agent.egress import (
    Connector,
    EgressPolicy,
    HttpResult,
    Resolver,
    WebhookNetworkError,
)
from duplexd_agent.tools import SharedToolHandler, build_tools
from duplexd_agent.webhooks import SignedWebhookRequest, WebhookDispatcher


class StubResolver(Resolver):
    def __init__(self, addresses: list[str]) -> None:
        self.addresses = addresses
        self.calls: list[tuple[str, int]] = []

    async def resolve(self, hostname: str, port: int) -> list[str]:
        self.calls.append((hostname, port))
        return list(self.addresses)


class CountingConnector(Connector):
    def __init__(
        self,
        *,
        status: int = 200,
        content: bytes = b'{"result":{"confirmed":true}}',
        error: BaseException | None = None,
    ) -> None:
        self.status = status
        self.content = content
        self.error = error
        self.requests: list[dict[str, Any]] = []

    async def send(
        self,
        *,
        url: str,
        pinned_address: str,
        headers: list[tuple[bytes, bytes]],
        content: bytes,
        timeout_secs: float,
    ) -> HttpResult:
        self.requests.append(
            {
                "url": url,
                "pinned_address": pinned_address,
                "headers": headers,
                "content": content,
                "timeout_secs": timeout_secs,
            }
        )
        if self.error is not None:
            raise self.error
        return HttpResult(status_code=self.status, content=self.content)


class RecordingEvents:
    def __init__(self) -> None:
        self.events: list[tuple[str, dict[str, Any]]] = []

    async def record(self, event_type: str, payload: dict[str, Any]) -> None:
        self.events.append((event_type, payload))


class Params:
    def __init__(self, arguments: Mapping[str, Any], tool_call_id: str = "same-tool-call") -> None:
        self.arguments = arguments
        self.tool_call_id = tool_call_id
        self.callback_values: list[Any] = []

    async def result_callback(self, value: Any) -> None:
        self.callback_values.append(value)


def _id_factory(values: list[str]) -> tuple[Iterator[str], Any]:
    iterator = iter(values)
    return iterator, lambda: next(iterator)


def _dispatcher(
    resolver: StubResolver,
    connector: CountingConnector,
    *,
    ids: list[str] | None = None,
    clock: float = 1_758_290_000.0,
    server_url: str = "https://customer.example/tools",
) -> WebhookDispatcher:
    id_values = ids or ["invocation-1", "invocation-2"]
    _iterator, factory = _id_factory(id_values)
    return WebhookDispatcher(
        server_url=server_url,
        server_secret="webhook-secret-canary-never-log",
        call_id="call_test_123",
        assistant_id="assistant_test_123",
        timeout_secs=1.25,
        egress_policy=EgressPolicy(resolver=resolver, allow_local=False),
        connector=connector,
        id_factory=factory,
        clock=lambda: clock,
    )


def _headers(request: SignedWebhookRequest) -> dict[str, str]:
    return {key.decode("ascii"): value.decode("utf-8") for key, value in request.headers}


def _verify_adr008(
    *, content: bytes, signature: str, secret: str, now: int, tolerance_secs: int = 300
) -> dict[str, Any]:
    parts = dict(item.split("=", 1) for item in signature.split(","))
    timestamp = int(parts["t"])
    expected = hmac.new(
        secret.encode("utf-8"),
        str(timestamp).encode("ascii") + b"." + content,
        hashlib.sha256,
    ).hexdigest()
    if not hmac.compare_digest(parts["v1"], expected):
        raise ValueError("bad signature")
    if abs(now - timestamp) > tolerance_secs:
        raise ValueError("stale signature")
    decoded = json.loads(content)
    if not isinstance(decoded, dict):
        raise ValueError("body is not an object")
    return decoded


def test_signed_request_uses_exact_transmitted_bytes_and_matching_identity_headers() -> None:
    dispatcher = _dispatcher(
        StubResolver(["93.184.216.34"]),
        CountingConnector(),
        ids=["invocation-exact"],
    )
    invocation = dispatcher.new_invocation("lookup_invoice", {"email": "a@example.test"})
    request = dispatcher.build_request(invocation)
    headers = _headers(request)

    body = _verify_adr008(
        content=request.content,
        signature=headers["duplexd-signature"],
        secret="webhook-secret-canary-never-log",
        now=invocation.timestamp,
    )

    assert body == {
        "tool": "lookup_invoice",
        "arguments": {"email": "a@example.test"},
        "callId": "call_test_123",
        "assistantId": "assistant_test_123",
        "invocationId": "invocation-exact",
    }
    assert headers["duplexd-call-id"] == body["callId"]
    assert headers["duplexd-assistant-id"] == body["assistantId"]
    assert headers["duplexd-invocation-id"] == body["invocationId"]

    mutated = request.content.replace(b"a@example.test", b"b@example.test")
    with pytest.raises(ValueError, match="signature"):
        _verify_adr008(
            content=mutated,
            signature=headers["duplexd-signature"],
            secret="webhook-secret-canary-never-log",
            now=invocation.timestamp,
        )

    alternate = json.dumps(body, indent=2, sort_keys=True).encode("utf-8")
    with pytest.raises(ValueError, match="signature"):
        _verify_adr008(
            content=alternate,
            signature=headers["duplexd-signature"],
            secret="webhook-secret-canary-never-log",
            now=invocation.timestamp,
        )


def test_rebuilding_one_invocation_reuses_identical_bytes_headers_timestamp_and_id() -> None:
    dispatcher = _dispatcher(
        StubResolver(["93.184.216.34"]),
        CountingConnector(),
        ids=["invocation-stable"],
    )
    invocation = dispatcher.new_invocation("restart_server", {"server_name": "web-1"})

    first = dispatcher.build_request(invocation)
    second = dispatcher.build_request(invocation)

    assert first == second
    assert first.invocation_id == "invocation-stable"


def test_two_intentional_calls_with_identical_arguments_receive_fresh_ids() -> None:
    dispatcher = _dispatcher(
        StubResolver(["93.184.216.34"]),
        CountingConnector(),
        ids=["fresh-one", "fresh-two"],
    )

    first = dispatcher.build_request(
        dispatcher.new_invocation("restart_server", {"server_name": "web-1"})
    )
    second = dispatcher.build_request(
        dispatcher.new_invocation("restart_server", {"server_name": "web-1"})
    )

    assert first.invocation_id == "fresh-one"
    assert second.invocation_id == "fresh-two"
    assert first.invocation_id != second.invocation_id
    assert json.loads(first.content)["invocationId"] == first.invocation_id
    assert json.loads(second.content)["invocationId"] == second.invocation_id


@pytest.mark.parametrize(
    ("addresses", "status", "content", "error", "expected_code", "expected_connections"),
    [
        (["10.0.0.1"], 200, b'{"result":true}', None, "webhook_destination_refused", 0),
        (["93.184.216.34"], 500, b'{"detail":"no"}', None, "webhook_http_error", 1),
        (["93.184.216.34"], 404, b'{"detail":"no"}', None, "webhook_http_error", 1),
        (["93.184.216.34"], 302, b"", None, "webhook_http_error", 1),
        (["93.184.216.34"], 200, b"not-json", None, "webhook_invalid_response", 1),
        (
            ["93.184.216.34"],
            200,
            b"",
            WebhookNetworkError("refused"),
            "webhook_unreachable",
            1,
        ),
        (["93.184.216.34"], 200, b"", TimeoutError(), "webhook_unreachable", 1),
        (
            ["93.184.216.34"],
            200,
            b"",
            RuntimeError("after send"),
            "webhook_internal_error",
            1,
        ),
    ],
)
async def test_handler_failure_matrix_returns_one_structured_result_and_never_retries(
    addresses: list[str],
    status: int,
    content: bytes,
    error: BaseException | None,
    expected_code: str,
    expected_connections: int,
) -> None:
    resolver = StubResolver(addresses)
    connector = CountingConnector(status=status, content=content, error=error)
    dispatcher = _dispatcher(resolver, connector, ids=["failure-id"])
    events = RecordingEvents()
    handler = SharedToolHandler(dispatcher, events, monotonic=iter([1.0, 1.25]).__next__)
    params = Params({"server_name": "web-1"})

    await handler(cast(FunctionCallParams, params), tool_name="restart_server")

    assert len(params.callback_values) == 1
    result = params.callback_values[0]
    assert result["ok"] is False
    assert result["error"]["code"] == expected_code
    assert len(connector.requests) == expected_connections
    assert [event for event, _payload in events.events] == ["tool_started", "tool_finished"]
    assert events.events[-1][1]["outcome"] == "failure"
    observable = json.dumps(
        {"callback": params.callback_values, "events": events.events},
        sort_keys=True,
    )
    assert "webhook-secret-canary-never-log" not in observable
    assert "agent-token-canary-never-log" not in observable


@pytest.mark.parametrize(
    ("url", "addresses", "expected_dns_calls"),
    [
        ("https://customer.example/tools", ["127.0.0.1"], 1),
        ("https://customer.example/tools", ["::1"], 1),
        ("https://customer.example/tools", ["10.0.0.1"], 1),
        ("https://customer.example/tools", ["172.16.0.1"], 1),
        ("https://customer.example/tools", ["192.168.1.1"], 1),
        ("https://customer.example/tools", ["169.254.169.254"], 1),
        ("https://customer.example/tools", ["fd00::1"], 1),
        ("https://customer.example/tools", ["fe80::1"], 1),
        ("https://customer.example/tools", ["::ffff:127.0.0.1"], 1),
        ("https://customer.example/tools", ["::ffff:10.0.0.1"], 1),
        ("https://customer.example/tools", ["0.0.0.0"], 1),
        ("https://customer.example/tools", ["100.64.0.1"], 1),
        ("https://customer.example/tools", ["224.0.0.1"], 1),
        ("https://customer.example/tools", ["ff02::1"], 1),
        ("https://customer.example/tools", ["64:ff9b::7f00:1"], 1),
        ("https://customer.example/tools", ["2002:7f00:1::1"], 1),
        ("https://customer.example/tools", ["93.184.216.34", "10.0.0.1"], 1),
        ("http://localhost/tools", ["127.0.0.1"], 1),
        ("http://127.0.0.1/tools", ["93.184.216.34"], 0),
    ],
)
async def test_real_handler_refuses_full_address_matrix_before_any_socket_connection(
    url: str,
    addresses: list[str],
    expected_dns_calls: int,
) -> None:
    resolver = StubResolver(addresses)
    connector = CountingConnector()
    dispatcher = _dispatcher(
        resolver,
        connector,
        ids=["refused-id"],
        server_url=url,
    )
    params = Params({"email": "a@example.test"})

    await SharedToolHandler(dispatcher, RecordingEvents())(
        cast(FunctionCallParams, params),
        tool_name="lookup_invoice",
    )

    assert len(resolver.calls) == expected_dns_calls
    assert connector.requests == []
    assert len(params.callback_values) == 1
    assert params.callback_values[0]["ok"] is False
    assert params.callback_values[0]["error"]["code"] == "webhook_destination_refused"


async def test_global_control_uses_identical_handler_seams_and_returns_customer_result() -> None:
    resolver = StubResolver(["93.184.216.34"])
    connector = CountingConnector(content=b'{"result":{"status":"confirmed"}}')
    dispatcher = _dispatcher(resolver, connector, ids=["success-id"])
    events = RecordingEvents()
    handler = SharedToolHandler(dispatcher, events, monotonic=iter([1.0, 1.1]).__next__)
    params = Params({"server_name": "web-1"})

    await handler(cast(FunctionCallParams, params), tool_name="restart_server")

    assert resolver.calls == [("customer.example", 443)]
    assert len(connector.requests) == 1
    assert connector.requests[0]["pinned_address"] == "93.184.216.34"
    assert connector.requests[0]["timeout_secs"] == 1.25
    assert params.callback_values == [{"status": "confirmed"}]
    assert events.events[-1][1]["outcome"] == "success"


async def test_adversarial_dns_answer_is_used_once_and_only_first_address_is_connected() -> None:
    class ChangingResolver(Resolver):
        def __init__(self) -> None:
            self.calls = 0

        async def resolve(self, hostname: str, port: int) -> list[str]:
            self.calls += 1
            return ["93.184.216.34"] if self.calls == 1 else ["10.0.0.1"]

    resolver = ChangingResolver()
    connector = CountingConnector(content=b'{"result":"customer-confirmed"}')
    dispatcher = WebhookDispatcher(
        server_url="https://customer.example/tools",
        server_secret="secret",
        call_id="call_test_123",
        assistant_id="assistant_test_123",
        timeout_secs=1.0,
        egress_policy=EgressPolicy(resolver=resolver, allow_local=False),
        connector=connector,
        id_factory=lambda: "dns-id",
        clock=lambda: 1_758_290_000.0,
    )

    _invocation, outcome = await dispatcher.invoke("lookup_invoice", {"email": "a@example"})

    assert resolver.calls == 1
    assert [request["pinned_address"] for request in connector.requests] == ["93.184.216.34"]
    assert outcome.ok is True
    assert outcome.result == "customer-confirmed"


async def test_same_pipecat_tool_call_id_and_arguments_do_not_become_the_idempotency_key() -> None:
    resolver = StubResolver(["93.184.216.34"])
    connector = CountingConnector(content=b'{"result":"confirmed"}')
    dispatcher = _dispatcher(resolver, connector, ids=["intentional-one", "intentional-two"])
    handler = SharedToolHandler(dispatcher, RecordingEvents())

    first = Params({"server_name": "web-1"}, tool_call_id="provider-tool-call-same")
    second = Params({"server_name": "web-1"}, tool_call_id="provider-tool-call-same")
    await handler(cast(FunctionCallParams, first), tool_name="restart_server")
    await handler(cast(FunctionCallParams, second), tool_name="restart_server")

    bodies = [json.loads(request["content"]) for request in connector.requests]
    assert [body["invocationId"] for body in bodies] == ["intentional-one", "intentional-two"]
    assert first.callback_values == second.callback_values == ["confirmed"]


def test_every_configured_tool_preserves_schema_and_uses_shared_handler(
    config_payload: dict[str, Any],
) -> None:
    config = AgentConfig.from_response(config_payload)
    dispatcher = _dispatcher(StubResolver(["93.184.216.34"]), CountingConnector())
    shared_handler = SharedToolHandler(dispatcher, RecordingEvents())

    tools = build_tools(config.tools, shared_handler)

    assert [tool.name for tool in tools] == ["lookup_invoice", "restart_server"]
    assert [tool.description for tool in tools] == [
        "Look up an invoice by email.",
        "Restart a named server.",
    ]
    assert tools[0].properties == {"email": {"type": "string"}}
    assert tools[0].required == ["email"]
    assert tools[1].properties == {"server_name": {"type": "string"}}
    assert tools[1].required == ["server_name"]
    assert all(tool.handler is not None for tool in tools)


def test_address_helper_control_accepts_known_global_address() -> None:
    from duplexd_agent.egress import is_safe_global_address

    assert is_safe_global_address(ipaddress.ip_address("93.184.216.34")) is True
