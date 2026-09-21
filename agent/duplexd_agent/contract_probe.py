"""Temporary, explicitly gated provider-contract probe for A01.

This module never loads assistant configuration, models, tools, or webhooks. It
exists only on the draft A01 branch and activates only for a validated
``providerContractProbe`` start body.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import secrets
import time
from collections.abc import Awaitable, Callable
from typing import Any, Literal

import httpx
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineWorker
from pipecat.runner.types import RunnerArguments
from pipecat.transports.base_transport import BaseTransport, TransportParams
from pipecat.workers.runner import WorkerRunner
from pydantic import BaseModel, ConfigDict, Field, HttpUrl, ValidationError, field_validator

from duplexd_agent.errors import AgentStartupError

ProbeMode = Literal[
    "register_pause_before_join",
    "register_join_wait",
    "no_register_join_wait",
]
TransportFactory = Callable[
    [RunnerArguments, dict[str, Callable[[], TransportParams]]],
    Awaitable[BaseTransport],
]

CALLBACK_TIMEOUT_SECS = 5.0
MAX_CALLBACK_ATTEMPTS = 3


class ContractProbeConfig(BaseModel):
    """Validated synthetic-only probe configuration from the start body."""

    model_config = ConfigDict(extra="forbid")

    version: Literal[1]
    run_id: str = Field(alias="runId", min_length=8, max_length=128)
    case_id: str = Field(alias="caseId", min_length=3, max_length=128)
    boot_id: str = Field(alias="bootId", min_length=8, max_length=128)
    mode: ProbeMode
    callback_url: HttpUrl = Field(alias="callbackUrl")
    callback_secret: str = Field(alias="callbackSecret", min_length=43, max_length=128, repr=False)

    @field_validator("callback_url")
    @classmethod
    def require_https_callback(cls, value: HttpUrl) -> HttpUrl:
        if value.scheme != "https":
            raise ValueError("contract probe callback must use HTTPS")
        return value

    @field_validator("callback_secret")
    @classmethod
    def require_256_bit_secret(cls, value: str) -> str:
        try:
            raw = base64.urlsafe_b64decode(f"{value}{'=' * (-len(value) % 4)}")
        except ValueError as error:
            raise ValueError("contract probe secret must be base64url") from error
        if len(raw) != 32:
            raise ValueError("contract probe secret must decode to 32 bytes")
        return value

    def secret_bytes(self) -> bytes:
        return base64.urlsafe_b64decode(
            f"{self.callback_secret}{'=' * (-len(self.callback_secret) % 4)}"
        )


def parse_contract_probe(body: object) -> ContractProbeConfig | None:
    """Return the gated probe config, or ``None`` for an ordinary call."""

    if not isinstance(body, dict) or "providerContractProbe" not in body:
        return None
    try:
        return ContractProbeConfig.model_validate(body["providerContractProbe"])
    except ValidationError:
        # Pydantic's diagnostic retains the rejected input, which can include
        # the one-time callback secret. Do not attach it to the exception chain.
        raise AgentStartupError("provider contract probe configuration is invalid") from None


def _token_claims(token: str | None) -> dict[str, object]:
    if not token:
        return {}
    parts = token.split(".")
    if len(parts) < 2:
        raise AgentStartupError("provider contract probe received an invalid Daily token")
    try:
        payload = base64.urlsafe_b64decode(f"{parts[1]}{'=' * (-len(parts[1]) % 4)}")
        value: object = json.loads(payload)
    except (ValueError, json.JSONDecodeError) as error:
        raise AgentStartupError("provider contract probe could not decode Daily claims") from error
    if not isinstance(value, dict):
        raise AgentStartupError("provider contract probe Daily claims are not an object")
    properties = value.get("properties", value)
    if not isinstance(properties, dict):
        properties = {}
    room_name = properties.get("room_name")
    return {
        "expiresAtEpochSeconds": properties.get("exp"),
        "ejectAtTokenExpiry": properties.get("eject_at_token_exp"),
        "isOwner": properties.get("is_owner"),
        "roomScoped": isinstance(room_name, str) and bool(room_name),
    }


class ProbeCallback:
    """HMAC-authenticated callback client that never logs its secret or payload."""

    def __init__(
        self,
        config: ContractProbeConfig,
        session_id: str,
        token: str | None,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._config = config
        self._session_id = session_id
        self._claims = _token_claims(token)
        self._client = httpx.AsyncClient(follow_redirects=False, transport=transport)

    async def __aenter__(self) -> ProbeCallback:
        return self

    async def __aexit__(self, *_args: object) -> None:
        await self._client.aclose()

    async def send(self, event: str) -> None:
        payload: dict[str, object] = {
            "version": 1,
            "runId": self._config.run_id,
            "caseId": self._config.case_id,
            "bootId": self._config.boot_id,
            "sessionId": self._session_id,
            "event": event,
            "observedAt": int(time.time()),
            "dailyClaims": self._claims,
        }
        body = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()

        for attempt in range(MAX_CALLBACK_ATTEMPTS):
            timestamp = str(int(time.time()))
            nonce = secrets.token_hex(16)
            signed = b".".join((timestamp.encode(), nonce.encode(), body))
            signature = hmac.new(self._config.secret_bytes(), signed, hashlib.sha256).hexdigest()
            try:
                response = await self._client.post(
                    str(self._config.callback_url),
                    content=body,
                    headers={
                        "content-type": "application/json",
                        "x-duplexd-contract-timestamp": timestamp,
                        "x-duplexd-contract-nonce": nonce,
                        "x-duplexd-contract-signature": f"v1={signature}",
                    },
                    timeout=CALLBACK_TIMEOUT_SECS,
                )
                if response.status_code == 204:
                    return
            except httpx.HTTPError:
                pass
            if attempt + 1 < MAX_CALLBACK_ATTEMPTS:
                await asyncio.sleep(0.25 * (2**attempt))
        raise AgentStartupError("provider contract callback failed")


async def run_contract_probe(
    runner_args: RunnerArguments,
    config: ContractProbeConfig,
    *,
    transport_factory: TransportFactory,
    transport_params: dict[str, Callable[[], TransportParams]],
) -> None:
    """Run one bounded probe mode until Pipecat stops/cancels the session."""

    if not runner_args.session_id:
        raise AgentStartupError("provider contract probe requires runner session_id")

    token = getattr(runner_args, "token", None)
    async with ProbeCallback(config, runner_args.session_id, token) as callback:
        if config.mode != "no_register_join_wait":
            await callback.send("registered")

        if config.mode == "register_pause_before_join":
            await asyncio.Event().wait()
            return

        transport = await transport_factory(runner_args, transport_params)
        joined = asyncio.Event()
        left = asyncio.Event()

        @transport.event_handler("on_joined")  # type: ignore[misc]
        async def on_joined(_transport: BaseTransport, _data: Any) -> None:
            joined.set()

        @transport.event_handler("on_left")  # type: ignore[misc]
        async def on_left(_transport: BaseTransport) -> None:
            left.set()

        pipeline = Pipeline([transport.input()])
        worker = PipelineWorker(pipeline, idle_timeout_secs=None)
        runner = WorkerRunner(handle_sigint=runner_args.handle_sigint)
        await runner.add_workers(worker)
        transport_task = asyncio.create_task(runner.run())
        left_task: asyncio.Task[bool] | None = None
        try:
            await asyncio.wait_for(joined.wait(), timeout=120)
            await callback.send("agent_joined")
            left_task = asyncio.create_task(left.wait())
            done, _pending = await asyncio.wait(
                {transport_task, left_task}, return_when=asyncio.FIRST_COMPLETED
            )
            if left_task in done and left.is_set():
                await callback.send("agent_left")
            # A Daily ejection must not become proof of provider process cleanup.
            # Remain alive until the provider stops/cancels the bot function.
            await asyncio.Event().wait()
        finally:
            if left_task is not None:
                left_task.cancel()
            transport_task.cancel()
            await asyncio.gather(
                *(task for task in (left_task, transport_task) if task is not None),
                return_exceptions=True,
            )
