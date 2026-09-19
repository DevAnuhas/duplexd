from __future__ import annotations

import ipaddress
import ssl
from collections.abc import Iterable
from typing import Any

import httpcore
import pytest

from duplexd_agent import egress
from duplexd_agent.egress import (
    EgressPolicy,
    EgressRefusedError,
    HttpcorePinnedConnector,
    PinnedNetworkBackend,
    is_safe_global_address,
    local_webhooks_enabled,
)


class RecordingResolver:
    def __init__(self, answers: list[str]) -> None:
        self.answers = answers
        self.calls: list[tuple[str, int]] = []

    async def resolve(self, hostname: str, port: int) -> list[str]:
        self.calls.append((hostname, port))
        return list(self.answers)


@pytest.mark.parametrize(
    "address",
    [
        "127.0.0.1",
        "::1",
        "10.0.0.1",
        "172.16.0.1",
        "192.168.1.1",
        "169.254.169.254",
        "fd00::1",
        "fe80::1",
        "::ffff:127.0.0.1",
        "::ffff:10.0.0.1",
        "0.0.0.0",
        "100.64.0.1",
        "224.0.0.1",
        "ff02::1",
        "64:ff9b::7f00:1",
        "2002:7f00:1::1",
    ],
)
async def test_egress_refuses_the_complete_non_global_address_matrix(address: str) -> None:
    resolver = RecordingResolver([address])
    policy = EgressPolicy(resolver=resolver, allow_local=False)

    with pytest.raises(EgressRefusedError, match="globally routable"):
        await policy.resolve("https://customer.example/tools")

    assert resolver.calls == [("customer.example", 443)]


@pytest.mark.parametrize("address", ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"])
async def test_egress_accepts_global_addresses_through_the_same_resolver_seam(address: str) -> None:
    resolver = RecordingResolver([address])
    policy = EgressPolicy(resolver=resolver, allow_local=False)

    resolved = await policy.resolve("https://customer.example/tools")

    assert resolved.address == address
    assert resolved.hostname == "customer.example"
    assert resolver.calls == [("customer.example", 443)]


async def test_egress_refuses_the_entire_answer_when_any_candidate_is_non_global() -> None:
    resolver = RecordingResolver(["93.184.216.34", "10.0.0.1"])

    with pytest.raises(EgressRefusedError, match="globally routable"):
        await EgressPolicy(resolver=resolver, allow_local=False).resolve(
            "https://customer.example/tools"
        )

    assert resolver.calls == [("customer.example", 443)]


@pytest.mark.parametrize(
    "url",
    [
        "customer.example/tools",
        "ftp://customer.example/tools",
        "https://user:pass@customer.example/tools",
        "https://customer.example/tools#fragment",
        "https://[fe80::1%25en0]/tools",
    ],
)
async def test_egress_refuses_invalid_urls_before_connecting(url: str) -> None:
    resolver = RecordingResolver(["93.184.216.34"])

    with pytest.raises(EgressRefusedError):
        await EgressPolicy(resolver=resolver, allow_local=False).resolve(url)

    assert resolver.calls == []


async def test_literal_ip_url_does_not_call_dns() -> None:
    resolver = RecordingResolver(["10.0.0.1"])
    policy = EgressPolicy(resolver=resolver, allow_local=False)

    resolved = await policy.resolve("https://93.184.216.34/tools")

    assert resolved.address == "93.184.216.34"
    assert resolver.calls == []


async def test_non_global_literal_ip_is_refused_without_calling_dns() -> None:
    resolver = RecordingResolver(["93.184.216.34"])
    policy = EgressPolicy(resolver=resolver, allow_local=False)

    with pytest.raises(EgressRefusedError, match="globally routable"):
        await policy.resolve("http://127.0.0.1/tools")

    assert resolver.calls == []


async def test_localhost_is_resolved_at_request_time_and_refused() -> None:
    resolver = RecordingResolver(["127.0.0.1", "::1"])
    policy = EgressPolicy(resolver=resolver, allow_local=False)

    with pytest.raises(EgressRefusedError, match="globally routable"):
        await policy.resolve("http://localhost/tools")

    assert resolver.calls == [("localhost", 80)]


async def test_resolver_is_called_once_per_tool_resolution_and_never_cached() -> None:
    resolver = RecordingResolver(["93.184.216.34"])
    policy = EgressPolicy(resolver=resolver, allow_local=False)

    first = await policy.resolve("https://customer.example/tools")
    resolver.answers = ["93.184.216.35"]
    second = await policy.resolve("https://customer.example/tools")

    assert first.address == "93.184.216.34"
    assert second.address == "93.184.216.35"
    assert resolver.calls == [
        ("customer.example", 443),
        ("customer.example", 443),
    ]


@pytest.mark.parametrize("value", [None, "", "0", "false", "TRUE", "yes"])
def test_local_webhooks_are_disabled_unless_flag_is_exactly_one(value: str | None) -> None:
    environment = {} if value is None else {egress.LOCAL_WEBHOOK_FLAG: value}

    assert local_webhooks_enabled(environment) is False


@pytest.mark.parametrize("value", [None, "", "0", "false"])
async def test_default_policy_refuses_local_resolution_when_flag_is_not_enabled(
    monkeypatch: pytest.MonkeyPatch, value: str | None
) -> None:
    if value is None:
        monkeypatch.delenv(egress.LOCAL_WEBHOOK_FLAG, raising=False)
    else:
        monkeypatch.setenv(egress.LOCAL_WEBHOOK_FLAG, value)
    resolver = RecordingResolver(["127.0.0.1"])

    with pytest.raises(EgressRefusedError, match="globally routable"):
        await EgressPolicy(resolver=resolver).resolve("http://customer.example/tools")

    assert resolver.calls == [("customer.example", 80)]


def test_local_webhook_flag_one_enables_and_warns(monkeypatch: pytest.MonkeyPatch) -> None:
    warnings: list[tuple[str, tuple[object, ...]]] = []

    class FakeLogger:
        def warning(self, message: str, *args: object) -> None:
            warnings.append((message, args))

    monkeypatch.setattr(egress, "logger", FakeLogger())

    monkeypatch.setenv(egress.LOCAL_WEBHOOK_FLAG, "1")
    policy = EgressPolicy(resolver=RecordingResolver([]))

    assert policy.allow_local is True
    assert warnings == [
        (
            "{}=1: non-global customer webhook destinations are enabled",
            (egress.LOCAL_WEBHOOK_FLAG,),
        )
    ]


@pytest.mark.parametrize(
    "address",
    [
        ipaddress.ip_address("224.0.0.1"),
        ipaddress.ip_address("ff02::1"),
        ipaddress.ip_address("::ffff:127.0.0.1"),
        ipaddress.ip_address("2002:7f00:1::1"),
        ipaddress.ip_address("64:ff9b::7f00:1"),
    ],
)
def test_safe_address_check_rejects_multicast_and_embedded_non_global_ipv4(
    address: ipaddress.IPv4Address | ipaddress.IPv6Address,
) -> None:
    assert is_safe_global_address(address) is False


class RecordingDelegateBackend(httpcore.AsyncNetworkBackend):
    def __init__(self) -> None:
        self.hosts: list[tuple[str, int]] = []

    async def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: Iterable[httpcore.SOCKET_OPTION] | None = None,
    ) -> httpcore.AsyncNetworkStream:
        self.hosts.append((host, port))
        raise OSError("stop after observing destination")

    async def connect_unix_socket(
        self,
        path: str,
        timeout: float | None = None,
        socket_options: Iterable[httpcore.SOCKET_OPTION] | None = None,
    ) -> httpcore.AsyncNetworkStream:
        raise AssertionError("not used")

    async def sleep(self, seconds: float) -> None:
        return None


async def test_pinned_network_backend_replaces_only_the_tcp_destination() -> None:
    delegate = RecordingDelegateBackend()
    backend = PinnedNetworkBackend("93.184.216.34", delegate=delegate)

    with pytest.raises(OSError):
        await backend.connect_tcp("customer.example", 443)

    assert backend.requested_hosts == ["customer.example"]
    assert delegate.hosts == [("93.184.216.34", 443)]


class ResponseStream(httpcore.AsyncNetworkStream):
    def __init__(self) -> None:
        self.writes: list[bytes] = []
        self.server_hostnames: list[str | bytes | None] = []
        self._response = b"HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n{\"ok\":true}"

    async def read(self, max_bytes: int, timeout: float | None = None) -> bytes:
        response, self._response = self._response, b""
        return response

    async def write(self, buffer: bytes, timeout: float | None = None) -> None:
        self.writes.append(buffer)

    async def aclose(self) -> None:
        return None

    async def start_tls(
        self,
        ssl_context: ssl.SSLContext,
        server_hostname: str | bytes | None = None,
        timeout: float | None = None,
    ) -> httpcore.AsyncNetworkStream:
        self.server_hostnames.append(server_hostname)
        return self

    def get_extra_info(self, info: str) -> Any:
        return None


class ResponseBackend(httpcore.AsyncNetworkBackend):
    def __init__(self, stream: ResponseStream) -> None:
        self.stream = stream
        self.destinations: list[tuple[str, int]] = []

    async def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: Iterable[httpcore.SOCKET_OPTION] | None = None,
    ) -> httpcore.AsyncNetworkStream:
        self.destinations.append((host, port))
        return self.stream

    async def connect_unix_socket(
        self,
        path: str,
        timeout: float | None = None,
        socket_options: Iterable[httpcore.SOCKET_OPTION] | None = None,
    ) -> httpcore.AsyncNetworkStream:
        raise AssertionError("not used")

    async def sleep(self, seconds: float) -> None:
        return None


async def test_https_connector_keeps_original_host_and_sni_while_using_pinned_address() -> None:
    stream = ResponseStream()
    backend = ResponseBackend(stream)
    pinned_addresses: list[str] = []

    def backend_factory(address: str) -> httpcore.AsyncNetworkBackend:
        pinned_addresses.append(address)
        return backend

    connector = HttpcorePinnedConnector(backend_factory=backend_factory)
    result = await connector.send(
        url="https://customer.example/tools",
        pinned_address="93.184.216.34",
        headers=[(b"content-type", b"application/json")],
        content=b"{}",
        timeout_secs=1.0,
    )

    request_bytes = b"".join(stream.writes)
    assert result.status_code == 200
    assert pinned_addresses == ["93.184.216.34"]
    assert backend.destinations == [("customer.example", 443)]
    assert stream.server_hostnames == ["customer.example"]
    assert b"Host: customer.example\r\n" in request_bytes
