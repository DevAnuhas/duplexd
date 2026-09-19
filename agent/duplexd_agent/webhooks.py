"""Signed, single-attempt customer webhook delivery."""

from __future__ import annotations

import hashlib
import hmac
import json
import time
import uuid
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from duplexd_agent.egress import (
    Connector,
    EgressPolicy,
    EgressRefusedError,
    HttpcorePinnedConnector,
    WebhookNetworkError,
)
from duplexd_agent.platform import encode_json


@dataclass(frozen=True)
class WebhookInvocation:
    tool: str
    arguments: Mapping[str, Any]
    call_id: str
    assistant_id: str
    invocation_id: str
    timestamp: int


@dataclass(frozen=True)
class SignedWebhookRequest:
    url: str
    content: bytes
    headers: tuple[tuple[bytes, bytes], ...]
    invocation_id: str


@dataclass(frozen=True)
class WebhookOutcome:
    ok: bool
    result: Any | None = None
    error_code: str | None = None
    status_code: int | None = None

    def callback_value(self) -> Any:
        if self.ok:
            return self.result
        error: dict[str, Any] = {
            "code": self.error_code or "webhook_failed",
            "message": "The customer webhook did not confirm the operation.",
        }
        if self.status_code is not None:
            error["status"] = self.status_code
        return {"ok": False, "error": error}


class WebhookDispatcher:
    """Build once, resolve once, connect to the checked address, send once."""

    def __init__(
        self,
        *,
        server_url: str,
        server_secret: str,
        call_id: str,
        assistant_id: str,
        timeout_secs: float,
        egress_policy: EgressPolicy | None = None,
        connector: Connector | None = None,
        id_factory: Callable[[], str] | None = None,
        clock: Callable[[], float] | None = None,
    ) -> None:
        self._server_url = server_url
        self._secret = server_secret.encode("utf-8")
        self._call_id = call_id
        self._assistant_id = assistant_id
        self._timeout_secs = timeout_secs
        self._egress = egress_policy or EgressPolicy()
        self._connector = connector or HttpcorePinnedConnector()
        self._id_factory = id_factory or (lambda: str(uuid.uuid4()))
        self._clock = clock or time.time

    def new_invocation(self, tool: str, arguments: Mapping[str, Any]) -> WebhookInvocation:
        return WebhookInvocation(
            tool=tool,
            arguments=arguments,
            call_id=self._call_id,
            assistant_id=self._assistant_id,
            invocation_id=self._id_factory(),
            timestamp=int(self._clock()),
        )

    def build_request(self, invocation: WebhookInvocation) -> SignedWebhookRequest:
        content = encode_json(
            {
                "tool": invocation.tool,
                "arguments": dict(invocation.arguments),
                "callId": invocation.call_id,
                "assistantId": invocation.assistant_id,
                "invocationId": invocation.invocation_id,
            }
        )
        signed = str(invocation.timestamp).encode("ascii") + b"." + content
        digest = hmac.new(self._secret, signed, hashlib.sha256).hexdigest()
        headers = (
            (b"content-type", b"application/json"),
            (b"duplexd-signature", f"t={invocation.timestamp},v1={digest}".encode("ascii")),
            (b"duplexd-call-id", invocation.call_id.encode("utf-8")),
            (b"duplexd-assistant-id", invocation.assistant_id.encode("utf-8")),
            (b"duplexd-invocation-id", invocation.invocation_id.encode("ascii")),
        )
        return SignedWebhookRequest(
            url=self._server_url,
            content=content,
            headers=headers,
            invocation_id=invocation.invocation_id,
        )

    async def deliver(self, request: SignedWebhookRequest) -> WebhookOutcome:
        try:
            resolved = await self._egress.resolve(request.url)
            response = await self._connector.send(
                url=request.url,
                pinned_address=resolved.address,
                headers=list(request.headers),
                content=request.content,
                timeout_secs=self._timeout_secs,
            )
        except EgressRefusedError:
            return WebhookOutcome(ok=False, error_code="webhook_destination_refused")
        except (WebhookNetworkError, TimeoutError):
            return WebhookOutcome(ok=False, error_code="webhook_unreachable")
        except Exception:  # noqa: BLE001 - all handler failures become one safe result
            return WebhookOutcome(ok=False, error_code="webhook_internal_error")

        if response.status_code != 200:
            return WebhookOutcome(
                ok=False,
                error_code="webhook_http_error",
                status_code=response.status_code,
            )
        try:
            payload = json.loads(response.content)
        except (json.JSONDecodeError, UnicodeDecodeError):
            return WebhookOutcome(ok=False, error_code="webhook_invalid_response")
        if not isinstance(payload, dict) or "result" not in payload:
            return WebhookOutcome(ok=False, error_code="webhook_invalid_response")
        return WebhookOutcome(ok=True, result=payload["result"], status_code=200)

    async def invoke(
        self,
        tool: str,
        arguments: Mapping[str, Any],
    ) -> tuple[WebhookInvocation, WebhookOutcome]:
        invocation = self.new_invocation(tool, arguments)
        request = self.build_request(invocation)
        outcome = await self.deliver(request)
        return invocation, outcome
