"""Authenticated control-plane client.

The platform base URL is supplied by duplexd itself and is deliberately not
subject to the customer-webhook SSRF policy. Only ``serverUrl`` crosses that
trust boundary.
"""

from __future__ import annotations

import json
import time
from types import TracebackType
from typing import Any

import httpx
from pydantic import ValidationError

from duplexd_agent.config import (
    AgentConfig,
    RunnerInput,
    SandboxAck,
    SandboxConfig,
    SandboxControl,
    SandboxOwner,
)
from duplexd_agent.errors import PlatformRequestError

CONFIG_FETCH_TIMEOUT_SECS = 5.0
REPORTING_TIMEOUT_SECS = 2.0


class PlatformClient:
    """One call-scoped client; the bearer token never enters a URL or log."""

    def __init__(
        self,
        runner_input: RunnerInput,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._call_id = runner_input.call_id
        self._api_base = runner_input.api_base
        self.sandbox_owner: SandboxOwner | None = None
        self.control_received_at = 0.0
        self._client = httpx.AsyncClient(
            headers={"Authorization": f"Bearer {runner_input.agent_token}"},
            follow_redirects=False,
            transport=transport,
        )

    async def __aenter__(self) -> PlatformClient:
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        await self._client.aclose()

    async def fetch_config(self) -> AgentConfig:
        try:
            response = await self._client.get(
                self._call_url("config"),
                timeout=CONFIG_FETCH_TIMEOUT_SECS,
            )
        except httpx.HTTPError:
            raise PlatformRequestError("assistant config request failed") from None
        if response.status_code != 200:
            raise PlatformRequestError(
                f"assistant config request returned HTTP {response.status_code}"
            )
        try:
            payload: object = response.json()
        except ValueError:
            raise PlatformRequestError("assistant config response was not JSON") from None
        return AgentConfig.from_response(payload)

    async def negotiate(self) -> str:
        response = await self._get("protocol")
        # Old Integration servers have no negotiation route. A Sandbox server
        # rejects legacy config before plaintext claim, so this cannot downgrade it.
        if response.status_code == 404:
            return "integration-v1"
        payload = self._json_response(response)
        if (
            not isinstance(payload, dict)
            or set(payload) != {"protocol"}
            or payload["protocol"] not in {"sandbox-v1", "integration-v1"}
        ):
            raise PlatformRequestError("unsupported runtime protocol")
        return str(payload["protocol"])

    async def register(self, owner: SandboxOwner) -> None:
        self.sandbox_owner = owner
        self._client.headers.update(
            {
                "x-duplexd-protocol": "sandbox-v1",
                "x-duplexd-session-id": owner.sessionId,
                "x-duplexd-boot-id": owner.bootId,
            }
        )
        try:
            response = await self._client.post(
                self._call_url("register"),
                content=encode_json(owner.model_dump()),
                headers={"Content-Type": "application/json"},
                timeout=CONFIG_FETCH_TIMEOUT_SECS,
            )
        except httpx.HTTPError:
            raise PlatformRequestError("runtime registration failed") from None
        if self._json_response(response) != {"protocol": "sandbox-v1", "registered": True}:
            raise PlatformRequestError("invalid runtime registration response")

    async def claim_sandbox(self) -> SandboxConfig:
        self.control_received_at = time.monotonic()
        response = await self._get("config")
        try:
            config = SandboxConfig.model_validate(self._json_response(response))
        except ValidationError:
            raise PlatformRequestError("invalid Sandbox configuration") from None
        if config.owner != self.sandbox_owner:
            raise PlatformRequestError("Sandbox configuration owner mismatch")
        return config

    async def poll_control(self) -> SandboxControl:
        started = time.monotonic()
        payload = self._json_response(await self._get("control"))
        if (
            not isinstance(payload, dict)
            or set(payload) != {"protocol", "control"}
            or payload["protocol"] != "sandbox-v1"
        ):
            raise PlatformRequestError("invalid runtime control response")
        try:
            control = SandboxControl.model_validate(payload["control"])
        except ValidationError:
            raise PlatformRequestError("invalid runtime control response") from None
        self.control_received_at = started
        return control

    async def post_evidence(self, suffix: str, body: bytes) -> SandboxAck | None:
        try:
            response = await self._client.post(
                self._call_url(suffix),
                content=body,
                headers={"Content-Type": "application/json"},
                timeout=REPORTING_TIMEOUT_SECS,
            )
            return SandboxAck.model_validate(self._json_response(response))
        except (httpx.HTTPError, PlatformRequestError, ValidationError):
            return None

    async def _get(self, suffix: str) -> httpx.Response:
        try:
            return await self._client.get(self._call_url(suffix), timeout=CONFIG_FETCH_TIMEOUT_SECS)
        except httpx.HTTPError:
            raise PlatformRequestError("runtime control request failed") from None

    @staticmethod
    def _json_response(response: httpx.Response) -> Any:
        if response.status_code != 200:
            raise PlatformRequestError(f"runtime request returned HTTP {response.status_code}")
        try:
            return response.json()
        except ValueError:
            raise PlatformRequestError("runtime response was not JSON") from None

    async def post_events(self, body: bytes) -> bool:
        return await self._post_bytes("events", body)

    async def post_complete(self, body: bytes) -> bool:
        return await self._post_bytes("complete", body)

    async def _post_bytes(self, suffix: str, body: bytes) -> bool:
        try:
            response = await self._client.post(
                self._call_url(suffix),
                content=body,
                headers={"Content-Type": "application/json"},
                timeout=REPORTING_TIMEOUT_SECS,
            )
        except httpx.HTTPError:
            return False
        return response.status_code == 200

    def _call_url(self, suffix: str) -> str:
        return f"{self._api_base}/v1/agent/calls/{self._call_id}/{suffix}"


def encode_json(value: Any) -> bytes:
    """Canonical-enough compact JSON: serialize once, then send these bytes."""

    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
