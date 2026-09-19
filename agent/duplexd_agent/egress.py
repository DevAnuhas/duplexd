"""Resolve-time webhook egress policy and DNS-pinned HTTP transport."""

from __future__ import annotations

import asyncio
import ipaddress
import os
import socket
import ssl
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Protocol
from urllib.parse import SplitResult, urlsplit

import httpcore
from loguru import logger

LOCAL_WEBHOOK_FLAG = "DUPLEXD_ALLOW_LOCAL_WEBHOOKS"
NAT64_WELL_KNOWN = ipaddress.IPv6Network("64:ff9b::/96")


class EgressRefusedError(Exception):
    """The webhook destination is invalid or not globally routable."""


class WebhookNetworkError(Exception):
    """The pinned connection failed without exposing a sensitive URL."""


class Resolver(Protocol):
    async def resolve(self, hostname: str, port: int) -> list[str]: ...


class Connector(Protocol):
    async def send(
        self,
        *,
        url: str,
        pinned_address: str,
        headers: list[tuple[bytes, bytes]],
        content: bytes,
        timeout_secs: float,
    ) -> HttpResult: ...


@dataclass(frozen=True)
class HttpResult:
    status_code: int
    content: bytes


class SystemResolver:
    """Resolve once per request and return every unique address."""

    async def resolve(self, hostname: str, port: int) -> list[str]:
        loop = asyncio.get_running_loop()
        try:
            records = await loop.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)
        except OSError:
            raise EgressRefusedError("webhook hostname could not be resolved") from None
        addresses = list(dict.fromkeys(record[4][0] for record in records))
        if not addresses:
            raise EgressRefusedError("webhook hostname returned no addresses")
        return addresses


class PinnedNetworkBackend(httpcore.AsyncNetworkBackend):
    """Keep the original HTTP origin but open TCP to the checked numeric address."""

    def __init__(
        self,
        pinned_address: str,
        delegate: httpcore.AsyncNetworkBackend | None = None,
    ) -> None:
        self.pinned_address = pinned_address
        self.requested_hosts: list[str] = []
        self._delegate = delegate or httpcore.AnyIOBackend()

    async def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: Iterable[httpcore.SOCKET_OPTION] | None = None,
    ) -> httpcore.AsyncNetworkStream:
        self.requested_hosts.append(host)
        return await self._delegate.connect_tcp(
            self.pinned_address,
            port,
            timeout=timeout,
            local_address=local_address,
            socket_options=socket_options,
        )

    async def connect_unix_socket(
        self,
        path: str,
        timeout: float | None = None,
        socket_options: Iterable[httpcore.SOCKET_OPTION] | None = None,
    ) -> httpcore.AsyncNetworkStream:
        raise WebhookNetworkError("Unix sockets are not valid webhook destinations")

    async def sleep(self, seconds: float) -> None:
        await self._delegate.sleep(seconds)


class HttpcorePinnedConnector:
    """HTTP/1.1 connector whose TCP destination cannot trigger a second DNS lookup.

    The request URL retains the original hostname. httpcore therefore emits the
    original Host header and verifies TLS with the original SNI hostname, while
    ``PinnedNetworkBackend`` replaces only the numeric TCP destination.
    """

    def __init__(
        self,
        *,
        backend_factory: Callable[[str], httpcore.AsyncNetworkBackend] | None = None,
        ssl_context: ssl.SSLContext | None = None,
    ) -> None:
        self._backend_factory = backend_factory or (lambda address: PinnedNetworkBackend(address))
        self._ssl_context = ssl_context or ssl.create_default_context()

    async def send(
        self,
        *,
        url: str,
        pinned_address: str,
        headers: list[tuple[bytes, bytes]],
        content: bytes,
        timeout_secs: float,
    ) -> HttpResult:
        backend = self._backend_factory(pinned_address)
        timeout = {
            "connect": timeout_secs,
            "read": timeout_secs,
            "write": timeout_secs,
            "pool": timeout_secs,
        }
        try:
            async with httpcore.AsyncConnectionPool(
                ssl_context=self._ssl_context,
                retries=0,
                network_backend=backend,
            ) as pool:
                response = await pool.request(
                    method=b"POST",
                    url=url,
                    headers=headers,
                    content=content,
                    extensions={"timeout": timeout},
                )
                response_content = await response.aread()
        except (
            httpcore.ConnectionNotAvailable,
            httpcore.NetworkError,
            httpcore.ProtocolError,
            httpcore.TimeoutException,
            httpcore.UnsupportedProtocol,
            OSError,
            WebhookNetworkError,
        ):
            raise WebhookNetworkError("webhook connection failed") from None
        return HttpResult(status_code=response.status, content=response_content)


@dataclass(frozen=True)
class ResolvedWebhook:
    url: str
    address: str
    hostname: str
    port: int


class EgressPolicy:
    def __init__(
        self,
        *,
        resolver: Resolver | None = None,
        allow_local: bool | None = None,
    ) -> None:
        self._resolver = resolver or SystemResolver()
        self.allow_local = local_webhooks_enabled() if allow_local is None else allow_local
        if self.allow_local:
            logger.warning(
                "{}=1: non-global customer webhook destinations are enabled",
                LOCAL_WEBHOOK_FLAG,
            )

    async def resolve(self, url: str) -> ResolvedWebhook:
        parsed = _parse_webhook_url(url)
        hostname = _ascii_hostname(parsed.hostname or "")
        port = parsed.port or (443 if parsed.scheme == "https" else 80)

        literal = _parse_ip_literal(hostname)
        if literal is not None:
            addresses = [str(literal)]
        else:
            addresses = await self._resolver.resolve(hostname, port)

        parsed_addresses: list[ipaddress.IPv4Address | ipaddress.IPv6Address] = []
        for address in addresses:
            try:
                candidate = ipaddress.ip_address(address)
            except ValueError:
                raise EgressRefusedError("webhook resolution returned an invalid address") from None
            if not self.allow_local and not is_safe_global_address(candidate):
                raise EgressRefusedError("webhook destination is not globally routable")
            parsed_addresses.append(candidate)

        if not parsed_addresses:
            raise EgressRefusedError("webhook hostname returned no addresses")
        return ResolvedWebhook(
            url=url,
            address=str(parsed_addresses[0]),
            hostname=hostname,
            port=port,
        )


def local_webhooks_enabled(environ: dict[str, str] | None = None) -> bool:
    values = os.environ if environ is None else environ
    return values.get(LOCAL_WEBHOOK_FLAG) == "1"


def is_safe_global_address(address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    """Reject non-global, multicast, and translated non-global IPv4 addresses."""

    if address.is_multicast or not address.is_global:
        return False
    if isinstance(address, ipaddress.IPv4Address):
        return True

    embedded: list[ipaddress.IPv4Address] = []
    if address.ipv4_mapped is not None:
        embedded.append(address.ipv4_mapped)
    if address.sixtofour is not None:
        embedded.append(address.sixtofour)
    if address.teredo is not None:
        embedded.extend(address.teredo)
    if address in NAT64_WELL_KNOWN:
        embedded.append(ipaddress.IPv4Address(int(address) & 0xFFFFFFFF))
    return all(is_safe_global_address(item) for item in embedded)


def _parse_webhook_url(url: str) -> SplitResult:
    try:
        parsed = urlsplit(url)
        port = parsed.port
    except ValueError:
        raise EgressRefusedError("webhook URL is invalid") from None
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise EgressRefusedError("webhook URL must use HTTP or HTTPS")
    if parsed.username is not None or parsed.password is not None:
        raise EgressRefusedError("webhook URL must not contain credentials")
    if parsed.fragment:
        raise EgressRefusedError("webhook URL must not contain a fragment")
    if port is not None and not 1 <= port <= 65535:
        raise EgressRefusedError("webhook URL port is invalid")
    return parsed


def _ascii_hostname(hostname: str) -> str:
    if "%" in hostname:
        raise EgressRefusedError("scoped IPv6 webhook addresses are not allowed")
    try:
        return hostname.encode("idna").decode("ascii")
    except UnicodeError:
        raise EgressRefusedError("webhook hostname is invalid") from None


def _parse_ip_literal(
    hostname: str,
) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    try:
        return ipaddress.ip_address(hostname)
    except ValueError:
        return None
