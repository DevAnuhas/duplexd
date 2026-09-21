"""Disposable Pipecat Cloud probe for the six #60 provider-contract cases."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import re
import secrets
import time
import urllib.error
import urllib.request
from collections.abc import Awaitable, Callable
from typing import Any
from urllib.parse import urlparse

from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineWorker
from pipecat.runner.types import RunnerArguments
from pipecat.runner.utils import create_transport
from pipecat.transports.base_transport import BaseTransport
from pipecat.transports.daily.transport import DailyParams
from pipecat.workers.runner import WorkerRunner

CASES = {
    "cold_start": (True, True),
    "cancel_before_join": (True, False),
    "lost_start_response_registered": (True, False),
    "no_registration_startup": (False, True),
    "hung_runtime": (True, True),
    "known_session_stop_retry": (True, False),
}
TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9_-]{43}$")
ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{7,127}$")


def parse_request(body: object) -> dict[str, str]:
    """Accept only the request-scoped fields needed by one disposable probe case."""

    if not isinstance(body, dict) or set(body) != {"providerProof"}:
        raise ValueError("invalid provider proof request")
    value = body["providerProof"]
    required = {"case", "runId", "bootId", "callbackUrl", "callbackSecret"}
    if not isinstance(value, dict) or set(value) != required:
        raise ValueError("invalid provider proof request")
    if value["case"] not in CASES:
        raise ValueError("invalid provider proof case")
    if not all(isinstance(value[key], str) for key in required):
        raise ValueError("invalid provider proof request")
    if not ID_PATTERN.fullmatch(value["runId"]) or not ID_PATTERN.fullmatch(
        value["bootId"]
    ):
        raise ValueError("invalid provider proof identity")
    if not TOKEN_PATTERN.fullmatch(value["callbackSecret"]):
        raise ValueError("invalid provider proof callback secret")
    parsed = urlparse(value["callbackUrl"])
    expected_path = f"/probe/{value['runId']}/{value['case']}/{value['bootId']}"
    if parsed.scheme != "https" or not parsed.netloc or parsed.path != expected_path:
        raise ValueError("invalid provider proof callback")
    if parsed.params or parsed.query or parsed.fragment:
        raise ValueError("invalid provider proof callback")
    return value


def daily_claims(token: str | None) -> dict[str, object]:
    """Expose only the Daily bounds needed to prove participant ejection."""

    if not token or len(token.split(".")) < 2:
        raise ValueError("invalid Daily token")
    encoded = token.split(".")[1]
    payload = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
    properties = payload.get("properties", payload)
    room = properties.get("room_name")
    return {
        "expiresAtEpochSeconds": properties.get("exp"),
        "ejectAtTokenExpiry": properties.get("eject_at_token_exp"),
        "isOwner": properties.get("is_owner"),
        "roomScoped": isinstance(room, str) and bool(room),
    }


async def send_event(
    config: dict[str, str], session_id: str, token: str | None, event: str
) -> None:
    """Send one secret-safe, exact-session event to the run-specific collector."""

    payload = json.dumps(
        {
            "runId": config["runId"],
            "case": config["case"],
            "bootId": config["bootId"],
            "sessionId": session_id,
            "event": event,
            "observedAt": int(time.time()),
            "dailyClaims": daily_claims(token),
        },
        separators=(",", ":"),
        sort_keys=True,
    ).encode()
    secret = base64.urlsafe_b64decode(config["callbackSecret"] + "=")

    def post(timestamp: str, nonce: str, signature: str) -> None:
        request = urllib.request.Request(
            config["callbackUrl"],
            data=payload,
            method="POST",
            headers={
                "content-type": "application/json",
                "x-provider-proof-timestamp": timestamp,
                "x-provider-proof-nonce": nonce,
                "x-provider-proof-signature": signature,
            },
        )
        with urllib.request.urlopen(request, timeout=5) as response:
            if response.status != 204:
                raise RuntimeError("provider proof callback rejected")

    for attempt in range(3):
        timestamp = str(int(time.time()))
        nonce = secrets.token_hex(16)
        signature = hmac.new(
            secret,
            b".".join((timestamp.encode(), nonce.encode(), payload)),
            hashlib.sha256,
        ).hexdigest()
        try:
            await asyncio.to_thread(post, timestamp, nonce, signature)
            return
        except (urllib.error.URLError, RuntimeError):
            if attempt == 2:
                raise RuntimeError("provider proof callback failed") from None
            await asyncio.sleep(0.25 * (2**attempt))


async def join_until_ejected(
    runner_args: RunnerArguments,
    notify: Callable[[str], Awaitable[None]],
) -> None:
    """Join Daily, report self-join/ejection, then remain alive for provider cessation."""

    transport = await create_transport(
        runner_args,
        {"daily": lambda: DailyParams(audio_in_enabled=False, audio_out_enabled=False)},
    )
    joined = asyncio.Event()
    left = asyncio.Event()

    @transport.event_handler("on_joined")  # type: ignore[misc]
    async def on_joined(_transport: BaseTransport, _data: Any) -> None:
        joined.set()

    @transport.event_handler("on_left")  # type: ignore[misc]
    async def on_left(_transport: BaseTransport) -> None:
        left.set()

    worker = PipelineWorker(Pipeline([transport.input()]), idle_timeout_secs=None)
    runner = WorkerRunner(handle_sigint=runner_args.handle_sigint)
    await runner.add_workers(worker)
    transport_task = asyncio.create_task(runner.run())
    try:
        await asyncio.wait_for(joined.wait(), timeout=120)
        await notify("agent_joined")
        await left.wait()
        await notify("agent_ejected")
        await asyncio.Event().wait()
    finally:
        transport_task.cancel()
        await asyncio.gather(transport_task, return_exceptions=True)


async def run_probe(
    runner_args: RunnerArguments,
    *,
    notify_impl: Callable[
        [dict[str, str], str, str | None, str], Awaitable[None]
    ] = send_event,
    join_impl: Callable[
        [RunnerArguments, Callable[[str], Awaitable[None]]], Awaitable[None]
    ] = join_until_ejected,
    hold_impl: Callable[[], Awaitable[None]] | None = None,
) -> None:
    """Execute exactly one selected case behavior."""

    config = parse_request(runner_args.body)
    if not runner_args.session_id:
        raise ValueError("provider proof requires a session ID")
    token = getattr(runner_args, "token", None)

    async def notify(event: str) -> None:
        await notify_impl(config, runner_args.session_id or "", token, event)

    register, join = CASES[config["case"]]
    if register:
        await notify("registered")
    if join:
        await join_impl(runner_args, notify)
    elif hold_impl is not None:
        await hold_impl()
    else:
        await asyncio.Event().wait()


async def bot(runner_args: RunnerArguments) -> None:
    await run_probe(runner_args)


def main() -> None:
    from pipecat.runner.run import main as pipecat_main

    pipecat_main()


if __name__ == "__main__":
    main()
