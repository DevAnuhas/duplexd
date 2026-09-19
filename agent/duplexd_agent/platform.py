"""Authenticated control-plane client.

The platform base URL is supplied by duplexd itself and is deliberately not
subject to the customer-webhook SSRF policy. Only ``serverUrl`` crosses that
trust boundary.
"""

from __future__ import annotations

import json
from types import TracebackType
from typing import Any

import httpx

from duplexd_agent.config import AgentConfig, RunnerInput
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
